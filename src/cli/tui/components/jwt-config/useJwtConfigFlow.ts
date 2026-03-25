import type { CustomClaimValidation } from '../../../../schema';
import type { ClaimsManagerMode, ConstraintType, CustomClaimEntry, JwtSubStep } from './types';
import { useCallback, useMemo, useState } from 'react';

export interface JwtConfig {
  discoveryUrl: string;
  allowedAudience?: string[];
  allowedClients?: string[];
  allowedScopes?: string[];
  customClaims?: CustomClaimValidation[];
  clientId?: string;
  clientSecret?: string;
}

interface UseJwtConfigFlowOptions {
  onComplete: (jwtConfig: JwtConfig) => void;
  onBack: () => void;
}

export function useJwtConfigFlow({ onComplete, onBack }: UseJwtConfigFlowOptions) {
  const [subStep, setSubStep] = useState<JwtSubStep>('discoveryUrl');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [selectedConstraints, setSelectedConstraints] = useState<Set<ConstraintType>>(new Set());
  const [audience, setAudience] = useState('');
  const [clients, setClients] = useState('');
  const [scopes, setScopes] = useState('');
  const [customClaims, setCustomClaims] = useState<CustomClaimEntry[]>([]);
  const [clientId, setClientId] = useState('');
  const [claimsManagerMode, setClaimsManagerMode] = useState<ClaimsManagerMode>('add');

  // Compute the ordered list of JWT sub-steps based on selected constraints
  const steps = useMemo<JwtSubStep[]>(() => {
    const result: JwtSubStep[] = ['discoveryUrl', 'constraintPicker'];
    if (selectedConstraints.has('audience')) result.push('audience');
    if (selectedConstraints.has('clients')) result.push('clients');
    if (selectedConstraints.has('scopes')) result.push('scopes');
    if (selectedConstraints.has('customClaims')) result.push('customClaims');
    result.push('clientId', 'clientSecret');
    return result;
  }, [selectedConstraints]);

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

  const finishConfig = useCallback(
    (clientSecret: string) => {
      const audienceList = selectedConstraints.has('audience') ? parseList(audience) : undefined;
      const clientsList = selectedConstraints.has('clients') ? parseList(clients) : undefined;
      const scopesList = selectedConstraints.has('scopes') ? parseList(scopes) : undefined;

      const config: JwtConfig = {
        discoveryUrl,
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
    [selectedConstraints, audience, clients, scopes, discoveryUrl, customClaims, clientId, onComplete]
  );

  const handlers = {
    handleDiscoveryUrl: (url: string) => {
      setDiscoveryUrl(url);
      setSubStep('constraintPicker');
    },
    handleConstraintsPicked: useCallback((selectedIds: string[]) => {
      const constraints = new Set(selectedIds as ConstraintType[]);
      setSelectedConstraints(constraints);
      const order: ConstraintType[] = ['audience', 'clients', 'scopes', 'customClaims'];
      const first = order.find(c => constraints.has(c));
      if (first) {
        setSubStep(first);
      } else {
        setSubStep('clientId');
      }
    }, []),
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
    goBack,
    handlers,
  };
}
