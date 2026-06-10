import { buildMountListItems } from '../buildMountListItems.js';
import { describe, expect, it } from 'vitest';

const mounts = [
  {
    accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-00000000000000001',
    mountPath: '/mnt/efs1',
  },
  {
    accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-00000000000000002',
    mountPath: '/mnt/efs2',
  },
];

describe('buildMountListItems', () => {
  it('empty mounts: only add + continue', () => {
    const items = buildMountListItems([], 'EFS', 2);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'add', spaceBefore: true });
    expect(items[1]).toMatchObject({ id: 'done', spaceBefore: false });
  });

  it('one mount: edit + remove + add + continue', () => {
    const items = buildMountListItems([mounts[0]!], 'EFS', 2);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ id: 'edit:0', title: expect.stringContaining('/mnt/efs1') });
    expect(items[1]).toMatchObject({ id: 'remove:0', title: expect.stringContaining('/mnt/efs1') });
    expect(items[2]).toMatchObject({ id: 'add', spaceBefore: true });
    expect(items[3]).toMatchObject({ id: 'done', spaceBefore: false });
  });

  it('at max mounts: no add button, spaceBefore on done', () => {
    const items = buildMountListItems(mounts, 'EFS', 2);
    expect(items).toHaveLength(5); // 2×(edit+remove) + done
    expect(items.find(i => i.id === 'add')).toBeUndefined();
    expect(items[4]).toMatchObject({ id: 'done', spaceBefore: true });
  });

  it('description shows last 30 chars of ARN', () => {
    const mount = mounts[0]!;
    const items = buildMountListItems([mount], 'EFS', 2);
    const editItem = items[0] as { description?: string };
    expect(editItem.description).toBe(mount.accessPointArn.slice(-30));
  });

  it('label uses provided label string', () => {
    const items = buildMountListItems([mounts[0]!], 'S3 Files', 2);
    expect(items[0]!.title).toContain('S3 Files');
    expect(items[2]).toMatchObject({ id: 'add', title: expect.stringContaining('S3 Files') });
  });

  it('edit/remove indices are correct for multiple mounts', () => {
    const items = buildMountListItems(mounts, 'EFS', 3);
    expect(items[0]).toMatchObject({ id: 'edit:0' });
    expect(items[1]).toMatchObject({ id: 'remove:0' });
    expect(items[2]).toMatchObject({ id: 'edit:1' });
    expect(items[3]).toMatchObject({ id: 'remove:1' });
  });
});
