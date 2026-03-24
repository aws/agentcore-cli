import { AddGatewayScreen } from '../AddGatewayScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DOWN_ARROW = '\x1B[B';
const ENTER = '\r';
const ESCAPE = '\x1B';
const SPACE = ' ';
const TAB = '\t';
const LEFT_ARROW = '\x1B[D';
const RIGHT_ARROW = '\x1B[C';
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_PROPS = {
  onComplete: vi.fn(),
  onExit: vi.fn(),
  existingGateways: [],
  unassignedTargets: [],
  existingPolicyEngines: [],
};

// Helper: navigate past the name step by pressing Enter to accept the generated default name
async function acceptName(stdin: ReturnType<typeof render>['stdin']) {
  await delay();
  stdin.write(ENTER);
  await delay();
}

// Helper: navigate past the name step then select CUSTOM_JWT (index 1) and confirm
async function navigateToJwtConfig(stdin: ReturnType<typeof render>['stdin']) {
  await acceptName(stdin);
  // Authorizer step: down to CUSTOM_JWT (index 1), then Enter
  stdin.write(DOWN_ARROW);
  await delay();
  stdin.write(ENTER);
  await delay();
}

// Helper: fill discovery URL sub-step with a valid OIDC URL
async function enterDiscoveryUrl(
  stdin: ReturnType<typeof render>['stdin'],
  url = 'https://example.com/.well-known/openid-configuration'
) {
  for (const ch of url) {
    stdin.write(ch);
  }
  await delay();
  stdin.write(ENTER);
  await delay();
}

// Helper: select at least one constraint (audience at index 0) and confirm
async function selectAudienceConstraint(stdin: ReturnType<typeof render>['stdin']) {
  // Cursor is already on the first item (audience). Toggle it with SPACE.
  stdin.write(SPACE);
  await delay();
  stdin.write(ENTER);
  await delay();
}

afterEach(() => vi.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: JWT Flow Navigation
// ─────────────────────────────────────────────────────────────────────────────

describe('JWT Flow Navigation', () => {
  it('shows "Configure Custom JWT Authorizer" after selecting CUSTOM_JWT', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);

    expect(lastFrame()).toContain('Configure Custom JWT Authorizer');
  });

  it('shows Discovery URL prompt on first JWT sub-step', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);

    expect(lastFrame()).toContain('Discovery URL');
  });

  it('shows error for invalid discovery URL (not a URL)', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);

    // Type an invalid URL
    for (const ch of 'not-a-url') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Must be a valid URL');
  });

  it('shows error for URL missing the OIDC well-known suffix', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);

    for (const ch of 'https://example.com/auth') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('/.well-known/openid-configuration');
  });

  it('proceeds to constraint picker after entering valid discovery URL', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    expect(lastFrame()).toContain('Select JWT constraints');
  });

  it('Esc from discovery URL goes back to authorizer step', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    // Now on discoveryUrl sub-step — press Escape
    stdin.write(ESCAPE);
    await delay();

    // Should be back on the authorizer step
    expect(lastFrame()).toContain('Select authorizer type');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Constraint Picker
// ─────────────────────────────────────────────────────────────────────────────

describe('Constraint Picker', () => {
  it('renders all 4 constraint items', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    const frame = lastFrame()!;
    expect(frame).toContain('Allowed Audiences');
    expect(frame).toContain('Allowed Clients');
    expect(frame).toContain('Allowed Scopes');
    expect(frame).toContain('Custom Claims');
  });

  it('selecting audience only proceeds to audience input', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);
    await selectAudienceConstraint(stdin);

    expect(lastFrame()).toContain('Allowed Audiences');
  });

  it('selecting multiple constraints flows through them in order', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    // Toggle audience (index 0) and clients (index 1)
    stdin.write(SPACE); // toggle audience
    await delay();
    stdin.write(DOWN_ARROW); // move to clients
    await delay();
    stdin.write(SPACE); // toggle clients
    await delay();
    stdin.write(ENTER);
    await delay();

    // First should be audience
    expect(lastFrame()).toContain('Allowed Audiences');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Constraint Inputs
// ─────────────────────────────────────────────────────────────────────────────

describe('Constraint Inputs', () => {
  it('audience input accepts text and submits', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);
    await selectAudienceConstraint(stdin); // now on audience sub-step

    for (const ch of 'aud-123, aud-456') {
      stdin.write(ch);
    }
    await delay();

    expect(lastFrame()).toContain('aud-123');

    stdin.write(ENTER);
    await delay();

    // After submitting audience, should have moved past (to clientId since audience is the only constraint)
    // clientId shows the optional OAuth credentials prompt
    expect(lastFrame()).toContain('OAuth Client ID');
  });

  it('clients input accepts text and submits', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    // Select only clients (index 1)
    stdin.write(DOWN_ARROW); // move to clients
    await delay();
    stdin.write(SPACE); // toggle clients
    await delay();
    stdin.write(ENTER);
    await delay();

    // Should be on clients sub-step
    expect(lastFrame()).toContain('Allowed Clients');

    for (const ch of 'client-abc') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    // Moved to clientId
    expect(lastFrame()).toContain('OAuth Client ID');
  });

  it('scopes input accepts text and submits', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    // Select only scopes (index 2)
    stdin.write(DOWN_ARROW); // move to clients
    await delay();
    stdin.write(DOWN_ARROW); // move to scopes
    await delay();
    stdin.write(SPACE); // toggle scopes
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Allowed Scopes');

    for (const ch of 'openid profile') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('OAuth Client ID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Custom Claims Form
// ─────────────────────────────────────────────────────────────────────────────

describe('Custom Claims Form', () => {
  // Helper: navigate all the way to the CustomClaimForm (add mode, started with no claims)
  async function navigateToClaimForm(stdin: ReturnType<typeof render>['stdin']) {
    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    // Select only customClaims (index 3)
    stdin.write(DOWN_ARROW); // move to clients
    await delay();
    stdin.write(DOWN_ARROW); // move to scopes
    await delay();
    stdin.write(DOWN_ARROW); // move to customClaims
    await delay();
    stdin.write(SPACE); // toggle customClaims
    await delay();
    stdin.write(ENTER);
    await delay();
    // Now in CustomClaimsManager in 'add' mode (no initial claims)
  }

  it('form shows all 4 fields', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    const frame = lastFrame()!;
    expect(frame).toContain('Claim name');
    expect(frame).toContain('Value type');
    expect(frame).toContain('Operator');
    expect(frame).toContain('Match value');
  });

  it('Tab cycles through fields', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Initially active field is claimName (cyan). After Tab should move to valueType.
    stdin.write(TAB);
    await delay();

    // Value type should be the highlighted field now
    expect(lastFrame()).toContain('String'); // default valueType rendered as 'String'
  });

  it('right arrow cycles value type from STRING to STRING_ARRAY', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Tab to valueType field
    stdin.write(TAB);
    await delay();

    // Right arrow to cycle to STRING_ARRAY
    stdin.write(RIGHT_ARROW);
    await delay();

    expect(lastFrame()).toContain('String Array');
  });

  it('left arrow on STRING wraps to STRING_ARRAY', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Tab to valueType field
    stdin.write(TAB);
    await delay();

    // Left arrow wraps around
    stdin.write(LEFT_ARROW);
    await delay();

    expect(lastFrame()).toContain('String Array');
  });

  it('right arrow cycles operator EQUALS → CONTAINS', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Tab twice: claimName → valueType → operator
    stdin.write(TAB);
    await delay();
    stdin.write(TAB);
    await delay();

    // Now on operator field, default is Equals. Right arrow cycles to Contains.
    stdin.write(RIGHT_ARROW);
    await delay();

    expect(lastFrame()).toContain('Contains');
  });

  it('right arrow cycles operator CONTAINS → CONTAINS_ANY', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Tab twice to operator
    stdin.write(TAB);
    await delay();
    stdin.write(TAB);
    await delay();

    // Cycle twice: Equals → Contains → Contains Any
    stdin.write(RIGHT_ARROW);
    await delay();
    stdin.write(RIGHT_ARROW);
    await delay();

    expect(lastFrame()).toContain('Contains Any');
  });

  it('Enter with empty claimName shows "Claim name is required" error', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Press Enter without filling in any fields
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Claim name is required');
  });

  it('Enter with claimName but empty matchValue shows "Match value is required" error', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClaimForm(stdin);

    // Type a claim name
    for (const ch of 'department') {
      stdin.write(ch);
    }
    await delay();

    // Enter advances through fields: claimName -> valueType -> operator -> matchValue
    stdin.write(ENTER); // advance to valueType
    await delay();
    stdin.write(ENTER); // advance to operator
    await delay();
    stdin.write(ENTER); // advance to matchValue
    await delay();
    stdin.write(ENTER); // submit on last field — matchValue is empty
    await delay();

    expect(lastFrame()).toContain('Match value is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Custom Claims Manager
// ─────────────────────────────────────────────────────────────────────────────

describe('Custom Claims Manager', () => {
  // Helper: navigate to custom claims manager and add one complete claim
  async function addOneClaim(stdin: ReturnType<typeof render>['stdin']) {
    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);

    // Select only customClaims (index 3)
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(SPACE);
    await delay();
    stdin.write(ENTER);
    await delay();

    // Now in CustomClaimForm (add mode). Fill out claimName.
    for (const ch of 'role') {
      stdin.write(ch);
    }
    await delay();

    // Tab to valueType, keep STRING
    stdin.write(TAB);
    await delay();
    // Tab to operator, keep EQUALS
    stdin.write(TAB);
    await delay();
    // Tab to matchValue
    stdin.write(TAB);
    await delay();
    for (const ch of 'admin') {
      stdin.write(ch);
    }
    await delay();

    // Enter to save
    stdin.write(ENTER);
    await delay();
    // Now back in list mode with one claim
  }

  it('after adding a claim, shows numbered list with claim summary', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await addOneClaim(stdin);

    const frame = lastFrame()!;
    expect(frame).toContain('1.'); // numbered list entry
    expect(frame).toContain('role');
  });

  it('shows Add claim, Edit existing claim, and Done actions after first claim', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await addOneClaim(stdin);

    const frame = lastFrame()!;
    expect(frame).toContain('Add claim');
    expect(frame).toContain('Edit existing claim');
    expect(frame).toContain('Done');
  });

  it('selecting Done completes the custom claims step and moves on', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await addOneClaim(stdin);

    // Navigate to Done (index 3 in list: Add claim=0, Edit=1, Delete=2, Done=3)
    stdin.write(DOWN_ARROW); // Add → Edit
    await delay();
    stdin.write(DOWN_ARROW); // Edit → Delete
    await delay();
    stdin.write(DOWN_ARROW); // Delete → Done
    await delay();
    stdin.write(ENTER); // Select Done
    await delay();

    // Should be on clientId sub-step
    expect(lastFrame()).toContain('OAuth Client ID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Confirm Review with JWT
// ─────────────────────────────────────────────────────────────────────────────

describe('Confirm Review with JWT', () => {
  // Helper: complete the full JWT flow with audience constraint only, skip client credentials
  async function completeJwtFlowWithAudience(stdin: ReturnType<typeof render>['stdin']) {
    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);
    await selectAudienceConstraint(stdin); // select audience only

    // Audience input
    for (const ch of 'aud-test') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    // clientId — skip (press Enter on empty)
    stdin.write(ENTER);
    await delay();

    // advanced-config step — press Enter to accept defaults
    stdin.write(ENTER);
    await delay();
  }

  it('confirm screen shows Discovery URL and configured constraints', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await completeJwtFlowWithAudience(stdin);

    const frame = lastFrame()!;
    expect(frame).toContain('Discovery URL');
    expect(frame).toContain('https://example.com/.well-known/openid-configuration');
  });

  it('confirm screen shows Allowed Audience value', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await completeJwtFlowWithAudience(stdin);

    expect(lastFrame()).toContain('Allowed Audience');
    expect(lastFrame()).toContain('aud-test');
  });

  it('confirm screen shows human-readable authorizer label', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await completeJwtFlowWithAudience(stdin);

    expect(lastFrame()).toContain('Custom JWT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: Optional Client Credentials
// ─────────────────────────────────────────────────────────────────────────────

describe('Optional Client Credentials', () => {
  // Helper: navigate to clientId sub-step with audience constraint satisfied
  async function navigateToClientId(stdin: ReturnType<typeof render>['stdin']) {
    await navigateToJwtConfig(stdin);
    await enterDiscoveryUrl(stdin);
    await selectAudienceConstraint(stdin);

    // Provide audience
    for (const ch of 'aud-123') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();
    // Now on clientId sub-step
  }

  it('shows optional OAuth credentials prompt at clientId step', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClientId(stdin);

    expect(lastFrame()).toContain('OAuth Client ID');
    expect(lastFrame()).toContain('Optional');
  });

  it('skipping client ID (empty Enter) proceeds without credentials', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClientId(stdin);

    // Press Enter with no input to skip
    stdin.write(ENTER);
    await delay();

    // Should advance past jwt-config to advanced-config (or include-targets if present)
    // With no unassigned targets, it goes to advanced-config
    expect(lastFrame()).toContain('Advanced Configuration');
  });

  it('providing client ID advances to client secret prompt', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClientId(stdin);

    for (const ch of 'my-client-id') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('OAuth Client Secret');
  });

  it('providing client ID and secret includes them in the config review', async () => {
    const { lastFrame, stdin } = render(<AddGatewayScreen {...DEFAULT_PROPS} />);

    await navigateToClientId(stdin);

    // Enter client ID
    for (const ch of 'my-client-id') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    // Enter client secret
    for (const ch of 'my-client-secret') {
      stdin.write(ch);
    }
    await delay();
    stdin.write(ENTER);
    await delay();

    // Advanced config — accept defaults
    stdin.write(ENTER);
    await delay();

    // Should be on confirm review, showing gateway credential entry
    expect(lastFrame()).toContain('Gateway Credential');
  });
});
