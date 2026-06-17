import type {
  CustomClaimValidation,
  EndpointIpAddressType,
  PrivateEndpoint,
  PrivateEndpointOverride,
} from '../../../../schema';
import type {
  ClaimsManagerMode,
  ConstraintType,
  CustomClaimEntry,
  DomainOverrideEntry,
  DomainOverridesManagerMode,
  JwtSubStep,
  PrivateEndpointType,
} from './types';
import { useCallback, useMemo, useState } from 'react';

export interface JwtConfig {
  discoveryUrl: string;
  allowedAudience?: string[];
  allowedClients?: string[];
  allowedScopes?: string[];
  customClaims?: CustomClaimValidation[];
  clientId?: string;
  clientSecret?: string;
  /** PrivateLink inbound endpoint for reaching the OIDC discovery URL (singular arm). */
  privateEndpoint?: PrivateEndpoint;
  /** Per-domain private-endpoint overrides (Lattice-only; ≤5). */
  privateEndpointOverrides?: PrivateEndpointOverride[];
}

interface UseJwtConfigFlowOptions {
  onComplete: (jwtConfig: JwtConfig) => void;
  onBack: () => void;
  /** Enable the PrivateLink-inbound sub-steps (harness only). Defaults to false. */
  enablePrivateEndpoint?: boolean;
}

export function useJwtConfigFlow({ onComplete, onBack, enablePrivateEndpoint = false }: UseJwtConfigFlowOptions) {
  const [subStep, setSubStep] = useState<JwtSubStep>('discoveryUrl');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [selectedConstraints, setSelectedConstraints] = useState<Set<ConstraintType>>(new Set());
  const [audience, setAudience] = useState('');
  const [clients, setClients] = useState('');
  const [scopes, setScopes] = useState('');
  const [customClaims, setCustomClaims] = useState<CustomClaimEntry[]>([]);
  const [clientId, setClientId] = useState('');
  const [claimsManagerMode, setClaimsManagerMode] = useState<ClaimsManagerMode>('add');
  // PrivateLink inbound state
  const [privateEndpointType, setPrivateEndpointType] = useState<PrivateEndpointType>('none');
  const [latticeResourceId, setLatticeResourceId] = useState('');
  const [vpcId, setVpcId] = useState('');
  const [vpcSubnets, setVpcSubnets] = useState('');
  const [vpcIpType, setVpcIpType] = useState<EndpointIpAddressType>('IPV4');
  const [vpcSecurityGroups, setVpcSecurityGroups] = useState('');
  const [vpcRoutingDomain, setVpcRoutingDomain] = useState('');
  const [domainOverrides, setDomainOverrides] = useState<DomainOverrideEntry[]>([]);
  const [overridesManagerMode, setOverridesManagerMode] = useState<DomainOverridesManagerMode>('list');

  // Compute the ordered list of JWT sub-steps based on selected constraints + private-endpoint arm
  const steps = useMemo<JwtSubStep[]>(() => {
    const result: JwtSubStep[] = ['discoveryUrl', 'constraintPicker'];
    if (selectedConstraints.has('audience')) result.push('audience');
    if (selectedConstraints.has('clients')) result.push('clients');
    if (selectedConstraints.has('scopes')) result.push('scopes');
    if (selectedConstraints.has('customClaims')) result.push('customClaims');
    if (enablePrivateEndpoint) {
      result.push('privateEndpointType');
      if (privateEndpointType === 'lattice') {
        // Per-domain overrides are Lattice-only (matches the service + AWS Console).
        result.push('latticeResourceId', 'domainOverrides');
      } else if (privateEndpointType === 'vpc') {
        result.push('vpcId', 'vpcSubnets', 'vpcIpType', 'vpcSecurityGroups', 'vpcRoutingDomain');
      }
    }
    result.push('clientId', 'clientSecret');
    return result;
  }, [selectedConstraints, privateEndpointType, enablePrivateEndpoint]);

  const stepIndex = steps.indexOf(subStep);

  const goNext = useCallback(() => {
    const nextStep = steps[stepIndex + 1];
    if (nextStep) setSubStep(nextStep);
  }, [steps, stepIndex]);

  const goBack = useCallback(() => {
    if (stepIndex <= 0) {
      onBack();
    } else {
      const prevStep = steps[stepIndex - 1];
      if (prevStep) setSubStep(prevStep);
    }
  }, [steps, stepIndex, onBack]);

  const parseList = (s: string) =>
    s
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);

  const buildPrivateEndpoint = useCallback((): PrivateEndpoint | undefined => {
    if (privateEndpointType === 'lattice' && latticeResourceId.trim()) {
      return { selfManagedLatticeResource: { resourceConfigurationIdentifier: latticeResourceId.trim() } };
    }
    if (privateEndpointType === 'vpc' && vpcId.trim()) {
      const sgs = parseList(vpcSecurityGroups);
      return {
        managedVpcResource: {
          vpcIdentifier: vpcId.trim(),
          subnetIds: parseList(vpcSubnets),
          endpointIpAddressType: vpcIpType,
          ...(sgs.length > 0 ? { securityGroupIds: sgs } : {}),
          ...(vpcRoutingDomain.trim() ? { routingDomain: vpcRoutingDomain.trim() } : {}),
        },
      };
    }
    return undefined;
  }, [privateEndpointType, latticeResourceId, vpcId, vpcSubnets, vpcIpType, vpcSecurityGroups, vpcRoutingDomain]);

  const finishConfig = useCallback(
    (clientSecret: string) => {
      const audienceList = selectedConstraints.has('audience') ? parseList(audience) : undefined;
      const clientsList = selectedConstraints.has('clients') ? parseList(clients) : undefined;
      const scopesList = selectedConstraints.has('scopes') ? parseList(scopes) : undefined;
      const privateEndpoint = buildPrivateEndpoint();
      // Overrides are Lattice-only and only collected under the lattice arm, so each maps to a
      // selfManagedLatticeResource — keeping every endpoint the same arm (the service's rule).
      const overrides: PrivateEndpointOverride[] | undefined =
        privateEndpointType === 'lattice' && domainOverrides.length > 0
          ? domainOverrides.map(o => ({
              domain: o.domain,
              privateEndpoint: {
                selfManagedLatticeResource: { resourceConfigurationIdentifier: o.resourceConfigurationId },
              },
            }))
          : undefined;

      const config: JwtConfig = {
        discoveryUrl,
        ...(privateEndpoint ? { privateEndpoint } : {}),
        ...(overrides ? { privateEndpointOverrides: overrides } : {}),
        ...(audienceList && audienceList.length > 0 ? { allowedAudience: audienceList } : {}),
        ...(clientsList && clientsList.length > 0 ? { allowedClients: clientsList } : {}),
        ...(scopesList && scopesList.length > 0 ? { allowedScopes: scopesList } : {}),
        ...(selectedConstraints.has('customClaims') && customClaims.length > 0
          ? {
              customClaims: customClaims.map(c => ({
                inboundTokenClaimName: c.claimName,
                inboundTokenClaimValueType: c.valueType,
                authorizingClaimMatchValue: {
                  claimMatchOperator: c.operator,
                  claimMatchValue:
                    c.valueType === 'STRING'
                      ? { matchValueString: c.matchValue }
                      : {
                          matchValueStringList: c.matchValue
                            .split(',')
                            .map(v => v.trim())
                            .filter(Boolean),
                        },
                },
              })),
            }
          : {}),
        ...(clientId.trim() ? { clientId, clientSecret } : {}),
      };

      onComplete(config);
      setSubStep('discoveryUrl');
    },
    [
      selectedConstraints,
      audience,
      clients,
      scopes,
      discoveryUrl,
      customClaims,
      clientId,
      buildPrivateEndpoint,
      privateEndpointType,
      domainOverrides,
      onComplete,
    ]
  );

  const handlers = {
    handleDiscoveryUrl: (url: string) => {
      setDiscoveryUrl(url);
      setSubStep('constraintPicker');
    },
    handleConstraintsPicked: useCallback(
      (selectedIds: string[]) => {
        const constraints = new Set(selectedIds as ConstraintType[]);
        setSelectedConstraints(constraints);
        const order: ConstraintType[] = ['audience', 'clients', 'scopes', 'customClaims'];
        const first = order.find(c => constraints.has(c));
        // Private-endpoint type follows the constraints block when enabled; else jump to clientId.
        setSubStep(first ?? (enablePrivateEndpoint ? 'privateEndpointType' : 'clientId'));
      },
      [enablePrivateEndpoint]
    ),
    handlePrivateEndpointType: (type: string) => {
      setPrivateEndpointType(type as PrivateEndpointType);
      // Step list recomputes from privateEndpointType; advance to the first step after it.
      if (type === 'lattice') setSubStep('latticeResourceId');
      else if (type === 'vpc') setSubStep('vpcId');
      else setSubStep('clientId');
    },
    handleLatticeResourceId: (value: string) => {
      setLatticeResourceId(value);
      setSubStep('domainOverrides');
    },
    handleDomainOverridesDone: useCallback((entries: DomainOverrideEntry[]) => {
      setDomainOverrides(entries);
      setSubStep('clientId');
    }, []),
    handleOverridesManagerModeChange: setOverridesManagerMode,
    handleVpcId: (value: string) => {
      setVpcId(value);
      setSubStep('vpcSubnets');
    },
    handleVpcSubnets: (value: string) => {
      setVpcSubnets(value);
      setSubStep('vpcIpType');
    },
    handleVpcIpType: (value: string) => {
      setVpcIpType(value as EndpointIpAddressType);
      setSubStep('vpcSecurityGroups');
    },
    handleVpcSecurityGroups: (value: string) => {
      setVpcSecurityGroups(value);
      setSubStep('vpcRoutingDomain');
    },
    handleVpcRoutingDomain: (value: string) => {
      setVpcRoutingDomain(value);
      setSubStep('clientId');
    },
    handleAudience: (value: string) => {
      setAudience(value);
      goNext();
    },
    handleClients: (value: string) => {
      setClients(value);
      goNext();
    },
    handleScopes: (value: string) => {
      setScopes(value);
      goNext();
    },
    handleCustomClaimsDone: useCallback(
      (claims: CustomClaimEntry[]) => {
        setCustomClaims(claims);
        goNext();
      },
      [goNext]
    ),
    handleClientId: (value: string) => {
      setClientId(value);
      goNext();
    },
    handleClientIdSkip: () => {
      setClientId('');
      finishConfig('');
    },
    handleClientSecret: (clientSecret: string) => {
      finishConfig(clientSecret);
    },
    handleClaimsManagerModeChange: setClaimsManagerMode,
  };

  return {
    subStep,
    steps,
    selectedConstraints,
    customClaims,
    discoveryUrl,
    audience,
    clients,
    scopes,
    claimsManagerMode,
    privateEndpointType,
    latticeResourceId,
    vpcId,
    vpcSubnets,
    vpcIpType,
    vpcSecurityGroups,
    vpcRoutingDomain,
    domainOverrides,
    overridesManagerMode,
    goBack,
    handlers,
  };
}
