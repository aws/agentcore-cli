#!/usr/bin/env python3
"""One-time setup: provision EFS and S3 Files access points for filesystem e2e tests.

Creates (idempotent — safe to re-run):
  - A VPC with a private subnet and NAT gateway (for VPC-mode agent access)
  - An EFS file system with a mount target and access point
  - An S3 bucket + IAM role + S3 Files file system with a mount target and access point
  - A security group allowing NFS (TCP 2049) between the agent and mount targets

Outputs a JSON fixture file (filesystem-resources.json) with all ARNs/IDs
needed by the e2e tests. Pass these as environment variables to CI:

  E2E_EFS_ACCESS_POINT_ARN
  E2E_S3_ACCESS_POINT_ARN
  E2E_FILESYSTEM_SUBNET_ID
  E2E_FILESYSTEM_SECURITY_GROUP_ID

Usage:
  python setup_filesystem.py [--output /path/to/output.json]

Requirements:
  pip install boto3
  AWS credentials with ec2, elasticfilesystem, s3, s3files, iam permissions
"""
import argparse
import json
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, "filesystem-resources.json")

# Resource name tags — all resources are tagged so they can be found / cleaned up.
TAGS = [
    {"Key": "agentcore-e2e-test", "Value": "byo-filesystem"},
    {"Key": "managed-by", "Value": "setup_byo_filesystem.py"},
]
TAG_FILTER = [{"Name": "tag:agentcore-e2e-test", "Values": ["byo-filesystem"]}]

# CIDR blocks
VPC_CIDR = "10.10.0.0/16"
PRIVATE_SUBNET_CIDR = "10.10.1.0/24"
PUBLIC_SUBNET_CIDR = "10.10.0.0/24"

# IAM role name for S3 Files
S3FILES_ROLE_NAME = "agentcore-e2e-test-byo-filesystem-s3files-role"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def ec2():
    return boto3.client("ec2", region_name=REGION)


def efs():
    return boto3.client("efs", region_name=REGION)


def s3():
    return boto3.client("s3", region_name=REGION)


def s3files():
    return boto3.client("s3files", region_name=REGION)


def iam():
    return boto3.client("iam", region_name=REGION)


def get_account_id():
    return boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]


def tag_resource_ec2(resource_id, name):
    ec2().create_tags(
        Resources=[resource_id],
        Tags=TAGS + [{"Key": "Name", "Value": name}],
    )
    print(f"  Tagged {resource_id} as '{name}'")


def wait_for(description, check_fn, interval=5, max_attempts=60):
    for attempt in range(max_attempts):
        result = check_fn()
        if result:
            return result
        print(f"  Waiting for {description} ({attempt + 1}/{max_attempts})...")
        time.sleep(interval)
    raise TimeoutError(f"Timed out waiting for {description}")


# ─────────────────────────────────────────────────────────────────────────────
# VPC
# ─────────────────────────────────────────────────────────────────────────────

def ensure_vpc():
    existing = ec2().describe_vpcs(Filters=TAG_FILTER)["Vpcs"]
    if existing:
        vpc_id = existing[0]["VpcId"]
        print(f"VPC already exists: {vpc_id}")
        return vpc_id

    print(f"Creating VPC ({VPC_CIDR})...")
    resp = ec2().create_vpc(CidrBlock=VPC_CIDR)
    vpc_id = resp["Vpc"]["VpcId"]
    tag_resource_ec2(vpc_id, "agentcore-e2e-test-byo-filesystem-vpc")
    ec2().modify_vpc_attribute(VpcId=vpc_id, EnableDnsHostnames={"Value": True})
    ec2().modify_vpc_attribute(VpcId=vpc_id, EnableDnsSupport={"Value": True})
    print(f"VPC created: {vpc_id}")
    return vpc_id


def ensure_internet_gateway(vpc_id):
    existing = ec2().describe_internet_gateways(
        Filters=[{"Name": "attachment.vpc-id", "Values": [vpc_id]}]
    )["InternetGateways"]
    if existing:
        igw_id = existing[0]["InternetGatewayId"]
        print(f"Internet gateway already exists: {igw_id}")
        return igw_id

    print("Creating internet gateway...")
    igw_id = ec2().create_internet_gateway()["InternetGateway"]["InternetGatewayId"]
    tag_resource_ec2(igw_id, "agentcore-e2e-test-byo-filesystem-igw")
    ec2().attach_internet_gateway(InternetGatewayId=igw_id, VpcId=vpc_id)
    print(f"Internet gateway created and attached: {igw_id}")
    return igw_id


def ensure_public_subnet(vpc_id):
    existing = ec2().describe_subnets(
        Filters=TAG_FILTER + [{"Name": "tag:Name", "Values": ["agentcore-e2e-test-byo-filesystem-public-subnet"]}]
    )["Subnets"]
    if existing:
        subnet_id = existing[0]["SubnetId"]
        print(f"Public subnet already exists: {subnet_id}")
        return subnet_id

    print(f"Creating public subnet ({PUBLIC_SUBNET_CIDR})...")
    resp = ec2().create_subnet(VpcId=vpc_id, CidrBlock=PUBLIC_SUBNET_CIDR)
    subnet_id = resp["Subnet"]["SubnetId"]
    tag_resource_ec2(subnet_id, "agentcore-e2e-test-byo-filesystem-public-subnet")
    ec2().modify_subnet_attribute(SubnetId=subnet_id, MapPublicIpOnLaunch={"Value": True})
    print(f"Public subnet created: {subnet_id}")
    return subnet_id


def ensure_private_subnet(vpc_id):
    existing = ec2().describe_subnets(
        Filters=TAG_FILTER + [{"Name": "tag:Name", "Values": ["agentcore-e2e-test-byo-filesystem-private-subnet"]}]
    )["Subnets"]
    if existing:
        subnet_id = existing[0]["SubnetId"]
        print(f"Private subnet already exists: {subnet_id}")
        return subnet_id

    print(f"Creating private subnet ({PRIVATE_SUBNET_CIDR})...")
    resp = ec2().create_subnet(VpcId=vpc_id, CidrBlock=PRIVATE_SUBNET_CIDR)
    subnet_id = resp["Subnet"]["SubnetId"]
    tag_resource_ec2(subnet_id, "agentcore-e2e-test-byo-filesystem-private-subnet")
    print(f"Private subnet created: {subnet_id}")
    return subnet_id


def ensure_nat_gateway(public_subnet_id):
    existing = ec2().describe_nat_gateways(
        Filters=TAG_FILTER + [{"Name": "state", "Values": ["available", "pending"]}]
    )["NatGateways"]
    if existing:
        nat_id = existing[0]["NatGatewayId"]
        print(f"NAT gateway already exists: {nat_id}")
        return nat_id

    print("Allocating Elastic IP for NAT gateway...")
    eip = ec2().allocate_address(
        Domain="vpc",
        TagSpecifications=[{
            "ResourceType": "elastic-ip",
            "Tags": TAGS + [{"Key": "Name", "Value": "agentcore-e2e-test-byo-filesystem-eip"}],
        }],
    )
    eip_alloc_id = eip["AllocationId"]

    print("Creating NAT gateway...")
    resp = ec2().create_nat_gateway(
        SubnetId=public_subnet_id,
        AllocationId=eip_alloc_id,
        TagSpecifications=[{
            "ResourceType": "natgateway",
            "Tags": TAGS + [{"Key": "Name", "Value": "agentcore-e2e-test-byo-filesystem-nat"}],
        }],
    )
    nat_id = resp["NatGateway"]["NatGatewayId"]

    print(f"Waiting for NAT gateway {nat_id} to become available...")
    waiter = boto3.client("ec2", region_name=REGION).get_waiter("nat_gateway_available")
    waiter.wait(NatGatewayIds=[nat_id])
    print(f"NAT gateway ready: {nat_id}")
    return nat_id


def ensure_route_tables(vpc_id, igw_id, nat_id, public_subnet_id, private_subnet_id):
    # Public route table
    pub_rts = ec2().describe_route_tables(
        Filters=TAG_FILTER + [{"Name": "tag:Name", "Values": ["agentcore-e2e-test-byo-filesystem-public-rt"]}]
    )["RouteTables"]
    if not pub_rts:
        print("Creating public route table...")
        rt = ec2().create_route_table(VpcId=vpc_id)["RouteTable"]
        pub_rt_id = rt["RouteTableId"]
        tag_resource_ec2(pub_rt_id, "agentcore-e2e-test-byo-filesystem-public-rt")
        ec2().create_route(RouteTableId=pub_rt_id, DestinationCidrBlock="0.0.0.0/0", GatewayId=igw_id)
        ec2().associate_route_table(RouteTableId=pub_rt_id, SubnetId=public_subnet_id)
        print(f"Public route table created: {pub_rt_id}")

    # Private route table
    priv_rts = ec2().describe_route_tables(
        Filters=TAG_FILTER + [{"Name": "tag:Name", "Values": ["agentcore-e2e-test-byo-filesystem-private-rt"]}]
    )["RouteTables"]
    if not priv_rts:
        print("Creating private route table...")
        rt = ec2().create_route_table(VpcId=vpc_id)["RouteTable"]
        priv_rt_id = rt["RouteTableId"]
        tag_resource_ec2(priv_rt_id, "agentcore-e2e-test-byo-filesystem-private-rt")
        ec2().create_route(RouteTableId=priv_rt_id, DestinationCidrBlock="0.0.0.0/0", NatGatewayId=nat_id)
        ec2().associate_route_table(RouteTableId=priv_rt_id, SubnetId=private_subnet_id)
        print(f"Private route table created: {priv_rt_id}")


def ensure_security_group(vpc_id):
    existing = ec2().describe_security_groups(
        Filters=TAG_FILTER + [{"Name": "vpc-id", "Values": [vpc_id]}]
    )["SecurityGroups"]
    if existing:
        sg_id = existing[0]["GroupId"]
        print(f"Security group already exists: {sg_id}")
        return sg_id

    print("Creating security group...")
    resp = ec2().create_security_group(
        GroupName="agentcore-e2e-test-byo-filesystem-sg",
        Description="AgentCore e2e filesystem tests - NFS between agent and mount targets",
        VpcId=vpc_id,
        TagSpecifications=[{
            "ResourceType": "security-group",
            "Tags": TAGS + [{"Key": "Name", "Value": "agentcore-e2e-test-byo-filesystem-sg"}],
        }],
    )
    sg_id = resp["GroupId"]

    # Allow NFS inbound from itself (agent and mount target share the same SG).
    # Default SG already has all-outbound, so no egress rule needed.
    ec2().authorize_security_group_ingress(
        GroupId=sg_id,
        IpPermissions=[{
            "IpProtocol": "tcp",
            "FromPort": 2049,
            "ToPort": 2049,
            "UserIdGroupPairs": [{"GroupId": sg_id}],
        }],
    )
    print(f"Security group created: {sg_id}")
    return sg_id


# ─────────────────────────────────────────────────────────────────────────────
# EFS
# ─────────────────────────────────────────────────────────────────────────────

def ensure_efs_file_system():
    all_fs = efs().describe_file_systems()["FileSystems"]
    for fs in all_fs:
        for tag in fs.get("Tags", []):
            if tag["Key"] == "agentcore-e2e-test" and tag["Value"] == "byo-filesystem":
                fs_id = fs["FileSystemId"]
                print(f"EFS file system already exists: {fs_id}")
                return fs_id

    print("Creating EFS file system...")
    resp = efs().create_file_system(
        PerformanceMode="generalPurpose",
        Encrypted=True,
        Tags=TAGS + [{"Key": "Name", "Value": "agentcore-e2e-test-byo-filesystem-efs"}],
    )
    fs_id = resp["FileSystemId"]

    print(f"Waiting for EFS file system {fs_id} to become available...")
    wait_for(
        f"EFS {fs_id} available",
        lambda: efs().describe_file_systems(FileSystemId=fs_id)["FileSystems"][0]["LifeCycleState"] == "available",
    )
    print(f"EFS file system created: {fs_id}")
    return fs_id


def ensure_efs_mount_target(fs_id, subnet_id, sg_id):
    existing = efs().describe_mount_targets(FileSystemId=fs_id)["MountTargets"]
    for mt in existing:
        if mt["SubnetId"] == subnet_id:
            mt_id = mt["MountTargetId"]
            print(f"EFS mount target already exists: {mt_id}")
            return mt_id

    print(f"Creating EFS mount target in subnet {subnet_id}...")
    resp = efs().create_mount_target(
        FileSystemId=fs_id,
        SubnetId=subnet_id,
        SecurityGroups=[sg_id],
    )
    mt_id = resp["MountTargetId"]

    print(f"Waiting for EFS mount target {mt_id} to become available...")
    wait_for(
        f"EFS mount target {mt_id} available",
        lambda: efs().describe_mount_targets(MountTargetId=mt_id)["MountTargets"][0]["LifeCycleState"] == "available",
    )
    print(f"EFS mount target created: {mt_id}")
    return mt_id


def ensure_efs_access_point(fs_id):
    existing = efs().describe_access_points(FileSystemId=fs_id)["AccessPoints"]
    for ap in existing:
        for tag in ap.get("Tags", []):
            if tag["Key"] == "agentcore-e2e-test" and tag["Value"] == "byo-filesystem":
                ap_arn = ap["AccessPointArn"]
                print(f"EFS access point already exists: {ap_arn}")
                return ap_arn

    print("Creating EFS access point...")
    resp = efs().create_access_point(
        FileSystemId=fs_id,
        PosixUser={"Uid": 1000, "Gid": 1000},
        RootDirectory={
            "Path": "/e2e",
            "CreationInfo": {"OwnerUid": 1000, "OwnerGid": 1000, "Permissions": "755"},
        },
        Tags=TAGS + [{"Key": "Name", "Value": "agentcore-e2e-test-byo-filesystem-efs-ap"}],
    )
    ap_arn = resp["AccessPointArn"]
    print(f"EFS access point created: {ap_arn}")
    return ap_arn


# ─────────────────────────────────────────────────────────────────────────────
# S3 Files
# ─────────────────────────────────────────────────────────────────────────────

def ensure_s3_bucket(account_id):
    """Create or find the S3 bucket backing the S3 Files file system."""
    bucket_name = f"agentcore-e2e-byo-fs-s3files-{account_id}-{REGION}"
    try:
        s3().head_bucket(Bucket=bucket_name)
        print(f"S3 bucket already exists: {bucket_name}")
        return bucket_name
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchBucket"):
            raise

    print(f"Creating S3 bucket: {bucket_name}")
    if REGION == "us-east-1":
        s3().create_bucket(Bucket=bucket_name)
    else:
        s3().create_bucket(
            Bucket=bucket_name,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )
    s3().put_bucket_tagging(
        Bucket=bucket_name,
        Tagging={"TagSet": TAGS},
    )
    s3().put_bucket_versioning(
        Bucket=bucket_name,
        VersioningConfiguration={"Status": "Enabled"},
    )
    print(f"S3 bucket created: {bucket_name}")
    return bucket_name


def ensure_s3files_iam_role(account_id, bucket_name):
    """Create or find the IAM role granting S3 Files access to the bucket."""
    try:
        role = iam().get_role(RoleName=S3FILES_ROLE_NAME)["Role"]
        role_arn = role["Arn"]
        print(f"S3 Files IAM role already exists: {role_arn}")
        return role_arn
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchEntity":
            raise

    print(f"Creating S3 Files IAM role: {S3FILES_ROLE_NAME}")
    trust_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "elasticfilesystem.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringEquals": {"aws:SourceAccount": account_id},
            },
        }],
    })
    resp = iam().create_role(
        RoleName=S3FILES_ROLE_NAME,
        AssumeRolePolicyDocument=trust_policy,
        Description="S3 Files access role for AgentCore e2e tests",
        Tags=[{"Key": k["Key"], "Value": k["Value"]} for k in TAGS],
    )
    role_arn = resp["Role"]["Arn"]

    bucket_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:HeadObject", "s3:HeadBucket"],
            "Resource": [
                f"arn:aws:s3:::{bucket_name}",
                f"arn:aws:s3:::{bucket_name}/*",
            ],
        }],
    })
    iam().put_role_policy(
        RoleName=S3FILES_ROLE_NAME,
        PolicyName="s3files-bucket-access",
        PolicyDocument=bucket_policy,
    )
    print(f"S3 Files IAM role created: {role_arn}")
    return role_arn


def ensure_s3files_file_system(bucket_name, role_arn):
    """Create or find the e2e S3 Files file system."""
    try:
        resp = s3files().list_file_systems()
        for fs in resp.get("fileSystems", []):
            for tag in fs.get("tags", []):
                if tag["key"] == "agentcore-e2e-test" and tag["value"] == "byo-filesystem":
                    fs_id = fs["fileSystemId"]
                    print(f"S3 Files file system already exists: {fs_id}")
                    return fs_id
    except ClientError as e:
        print(f"Warning: could not list S3 Files file systems: {e}", file=sys.stderr)

    print("Creating S3 Files file system...")
    bucket_arn = f"arn:aws:s3:::{bucket_name}"
    resp = s3files().create_file_system(
        bucket=bucket_arn,
        roleArn=role_arn,
        tags=[{"key": k["Key"], "value": k["Value"]} for k in TAGS]
        + [{"key": "Name", "value": "agentcore-e2e-test-byo-filesystem-s3files"}],
    )
    fs_id = resp["fileSystemId"]
    print(f"Waiting for S3 Files file system {fs_id} to become available...")
    wait_for(
        f"S3 Files {fs_id} available",
        lambda: s3files().list_file_systems().get("fileSystems", []) and
                next((fs["status"] for fs in s3files().list_file_systems()["fileSystems"]
                      if fs["fileSystemId"] == fs_id), None) == "available",
    )
    print(f"S3 Files file system created: {fs_id}")
    return fs_id


def ensure_s3files_mount_target(fs_id, subnet_id, sg_id):
    """Create an S3 Files mount target in the private subnet."""
    existing = s3files().list_mount_targets(fileSystemId=fs_id).get("mountTargets", [])
    for mt in existing:
        if mt.get("subnetId") == subnet_id:
            mt_id = mt["mountTargetId"]
            print(f"S3 Files mount target already exists: {mt_id}")
            return mt_id

    print(f"Creating S3 Files mount target in subnet {subnet_id}...")
    resp = s3files().create_mount_target(
        fileSystemId=fs_id,
        subnetId=subnet_id,
        securityGroups=[sg_id],
    )
    mt_id = resp["mountTargetId"]
    print(f"Waiting for S3 Files mount target {mt_id} to become available...")
    wait_for(
        f"S3 Files mount target {mt_id} available",
        lambda: s3files().get_mount_target(mountTargetId=mt_id).get("status") in ("available",),
    )
    print(f"S3 Files mount target created: {mt_id}")
    return mt_id


def ensure_s3files_access_point(fs_id):
    """Create or find the e2e S3 Files access point."""
    existing = s3files().list_access_points(fileSystemId=fs_id).get("accessPoints", [])
    for ap in existing:
        for tag in ap.get("tags", []):
            if tag["key"] == "agentcore-e2e-test" and tag["value"] == "byo-filesystem":
                ap_arn = ap["accessPointArn"]
                print(f"S3 Files access point already exists: {ap_arn}")
                return ap_arn

    print("Creating S3 Files access point...")
    resp = s3files().create_access_point(
        fileSystemId=fs_id,
        posixUser={"uid": 1000, "gid": 1000},
        rootDirectory={
            "path": "/e2e",
            "creationPermissions": {"ownerUid": 1000, "ownerGid": 1000, "permissions": "755"},
        },
        tags=[{"key": k["Key"], "value": k["Value"]} for k in TAGS]
        + [{"key": "Name", "value": "agentcore-e2e-test-byo-filesystem-s3files-ap"}],
    )
    ap_arn = resp["accessPointArn"]
    print(f"S3 Files access point created: {ap_arn}")
    return ap_arn


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Path to write the resource JSON fixture")
    args = parser.parse_args()

    account_id = get_account_id()
    print(f"Account: {account_id}  Region: {REGION}")
    print()

    print("=== VPC ===")
    vpc_id = ensure_vpc()
    igw_id = ensure_internet_gateway(vpc_id)
    public_subnet_id = ensure_public_subnet(vpc_id)
    private_subnet_id = ensure_private_subnet(vpc_id)
    nat_id = ensure_nat_gateway(public_subnet_id)
    ensure_route_tables(vpc_id, igw_id, nat_id, public_subnet_id, private_subnet_id)
    sg_id = ensure_security_group(vpc_id)
    print()

    print("=== EFS ===")
    efs_fs_id = ensure_efs_file_system()
    ensure_efs_mount_target(efs_fs_id, private_subnet_id, sg_id)
    efs_ap_arn = ensure_efs_access_point(efs_fs_id)
    print()

    print("=== S3 Files ===")
    bucket_name = ensure_s3_bucket(account_id)
    role_arn = ensure_s3files_iam_role(account_id, bucket_name)
    s3files_fs_id = ensure_s3files_file_system(bucket_name, role_arn)
    ensure_s3files_mount_target(s3files_fs_id, private_subnet_id, sg_id)
    s3files_ap_arn = ensure_s3files_access_point(s3files_fs_id)
    print()

    resources = {
        "vpc_id": vpc_id,
        "private_subnet_id": private_subnet_id,
        "security_group_id": sg_id,
        "efs_access_point_arn": efs_ap_arn,
        "s3files_access_point_arn": s3files_ap_arn,
    }

    with open(args.output, "w") as f:
        json.dump(resources, f, indent=2)

    print(f"Resources written to: {args.output}")
    print()
    print("Add these as CI environment variables:")
    print(f"  E2E_EFS_ACCESS_POINT_ARN={efs_ap_arn}")
    print(f"  E2E_S3_ACCESS_POINT_ARN={s3files_ap_arn}")
    print(f"  E2E_FILESYSTEM_SUBNET_ID={private_subnet_id}")
    print(f"  E2E_FILESYSTEM_SECURITY_GROUP_ID={sg_id}")


if __name__ == "__main__":
    main()
