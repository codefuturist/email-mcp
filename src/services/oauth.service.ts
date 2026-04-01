/**
 * OAuth2 token management service.
 *
 * Handles token refresh and caching for Google and Microsoft OAuth2/XOAUTH2.
 * Supports both authorization code flow and device code flow (for corporate
 * M365 environments where admin-registered apps aren't available).
 *
 * Uses native fetch (Node 22+) — no external HTTP dependencies.
 */

import type { OAuth2Config } from '../types/index.js';

// ---------------------------------------------------------------------------
// Provider endpoint configs
// ---------------------------------------------------------------------------

interface ProviderEndpoints {
  tokenUrl: string;
  authUrl: string;
  deviceCodeUrl?: string;
  scopes: string[];
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoints> = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://mail.google.com/'],
  },
  microsoft: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    deviceCodeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ],
  },
};

// ---------------------------------------------------------------------------
// Well-known public client IDs for device code flow.
//
// These are first-party app registrations that are pre-approved in most
// Microsoft 365 tenants, avoiding the need for admin consent or a custom
// app registration. Users select one during `email-mcp account add`.
// ---------------------------------------------------------------------------

export interface WellKnownClient {
  id: string;
  name: string;
  description: string;
}

export const WELL_KNOWN_CLIENTS: WellKnownClient[] = [
  {
    id: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
    name: 'Thunderbird',
    description: 'Mozilla Thunderbird — widely pre-approved in corporate tenants',
  },
  {
    id: '08162f7c-0fd2-4200-a84a-f25a4db0b584',
    name: 'Microsoft Office',
    description: 'Microsoft Office public client — available in all M365 tenants',
  },
];

// ---------------------------------------------------------------------------
// Device code flow types
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  message: string;
}

export interface DeviceCodeTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 5-minute safety buffer before token expiry */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export default class OAuthService {
  /**
   * Get a valid access token, refreshing if expired.
   */
  // eslint-disable-next-line class-methods-use-this
  async getAccessToken(oauth2: OAuth2Config): Promise<string> {
    if (!OAuthService.isTokenExpired(oauth2) && oauth2.accessToken) {
      return oauth2.accessToken;
    }

    const result = await OAuthService.refreshAccessToken(oauth2);

    // Cache on the config object (in-memory only)
    Object.assign(oauth2, {
      accessToken: result.accessToken,
      tokenExpiry: Date.now() + result.expiresIn * 1000,
    });

    return result.accessToken;
  }

  /**
   * Check if the cached access token is expired or missing.
   */
  static isTokenExpired(oauth2: OAuth2Config): boolean {
    if (!oauth2.accessToken || !oauth2.tokenExpiry) return true;
    return Date.now() >= oauth2.tokenExpiry - TOKEN_EXPIRY_BUFFER_MS;
  }

  /**
   * Exchange refresh token for a new access token.
   */
  static async refreshAccessToken(
    oauth2: OAuth2Config,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: oauth2.clientId,
      refresh_token: oauth2.refreshToken,
    };
    // client_secret is omitted for public clients (device code flow)
    if (oauth2.clientSecret) {
      params.client_secret = oauth2.clientSecret;
    }
    const body = new URLSearchParams(params);

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 token refresh failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Get provider endpoints for token exchange and authorization.
   */
  static getProviderEndpoints(oauth2: OAuth2Config): ProviderEndpoints {
    if (oauth2.provider === 'custom') {
      if (!oauth2.tokenUrl || !oauth2.authUrl) {
        throw new Error('Custom OAuth2 provider requires tokenUrl and authUrl');
      }
      return {
        tokenUrl: oauth2.tokenUrl,
        authUrl: oauth2.authUrl,
        scopes: oauth2.scopes ?? [],
      };
    }

    const endpoints = PROVIDER_ENDPOINTS[oauth2.provider];
    if (!endpoints) {
      throw new Error(`Unknown OAuth2 provider: ${oauth2.provider}`);
    }
    return endpoints;
  }

  /**
   * Generate an OAuth2 authorization URL for the CLI setup wizard.
   */
  static generateAuthUrl(oauth2: OAuth2Config, redirectUri: string): string {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);
    const params = new URLSearchParams({
      client_id: oauth2.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: endpoints.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${endpoints.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (initial setup).
   */
  static async exchangeCode(
    oauth2: OAuth2Config,
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 code exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  // -------------------------------------------------------------------------
  // Device Code Flow — for corporate M365 without custom app registration
  // -------------------------------------------------------------------------

  /**
   * Initiate device code flow.
   * Returns a user code and verification URL to display to the user.
   * The user visits the URL, enters the code, and authenticates in a browser.
   */
  static async requestDeviceCode(
    clientId: string,
    provider: 'microsoft' | 'google' = 'microsoft',
  ): Promise<DeviceCodeResponse> {
    const endpoints = PROVIDER_ENDPOINTS[provider];
    if (!endpoints?.deviceCodeUrl) {
      throw new Error(`Device code flow is not supported for provider "${provider}"`);
    }

    const body = new URLSearchParams({
      client_id: clientId,
      scope: endpoints.scopes.join(' '),
    });

    const response = await fetch(endpoints.deviceCodeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Device code request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
      message: string;
    };

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
      message: data.message,
    };
  }

  /**
   * Poll for device code token completion.
   * Blocks until the user completes authentication, the code expires,
   * or an unrecoverable error occurs.
   *
   * @param clientId - The public client ID.
   * @param deviceCode - The device code from requestDeviceCode().
   * @param interval - Polling interval in seconds.
   * @param expiresIn - Seconds until the device code expires.
   * @param onPoll - Optional callback invoked on each poll (for progress display).
   */
  static async pollDeviceCodeToken(
    clientId: string,
    deviceCode: string,
    interval: number,
    expiresIn: number,
    onPoll?: () => void,
  ): Promise<DeviceCodeTokenResult> {
    const { tokenUrl } = PROVIDER_ENDPOINTS.microsoft;
    const deadline = Date.now() + expiresIn * 1000;
    let pollMs = Math.max(interval, 5) * 1000; // Microsoft requires >= 5s

    async function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    /* eslint-disable no-await-in-loop -- polling loop requires sequential awaits */
    while (Date.now() < deadline) {
      onPoll?.();

      await sleep(pollMs);

      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (data.access_token && data.refresh_token) {
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in ?? 3600,
        };
      }

      if (data.error === 'slow_down') {
        // Back off by adding 5 seconds (per spec)
        pollMs += 5000;
      } else if (data.error !== 'authorization_pending') {
        // Any error other than pending/slow_down is terminal
        throw new Error(
          `Device code authentication failed: ${data.error} — ${data.error_description ?? 'unknown error'}`,
        );
      }
    }
    /* eslint-enable no-await-in-loop */

    throw new Error('Device code expired. Please try again.');
  }
}
