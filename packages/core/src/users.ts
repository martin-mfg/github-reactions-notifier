import axios from "axios";

const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

interface GitHubAccessTokenResponse {
  access_token?: string;
  scope?: string;
}

/**
 * Deletes the user's grant of this OAuth App, which also invalidates every token issued under
 * it, as github-stats-extended's downgrade path does.
 *
 * @param accessToken Any valid token of the grant to delete.
 */
export async function deleteGrant(accessToken: string): Promise<void> {
  const { OAUTH_CLIENT_ID: clientId, OAUTH_CLIENT_SECRET: clientSecret } =
    process.env;
  if (!clientId || !clientSecret) {
    throw new Error(
      "OAuth Error: One or more required environment variables (OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET) are not set.",
    );
  }

  try {
    await axios.delete(
      `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`,
      {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        maxRedirects: 0,
        auth: { username: clientId, password: clientSecret },
        data: { access_token: accessToken },
        headers: { Accept: "application/vnd.github+json" },
      },
    );
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`OAuth Error: grant deletion: ${err.response.status}`);
    }
    throw err;
  }
}

/**
 * Exchanges an OAuth code without looking up the token's owner. Callers must check scope
 * before using the token for identity requests or storing it.
 *
 * @param code GitHub authentication code from OAuth process
 * @returns The access token and whether its exchange response carries any scope.
 */
export async function githubAuthenticate(
  code: string,
): Promise<{ accessToken: string; hasScope: boolean }> {
  const {
    OAUTH_CLIENT_ID: clientId,
    OAUTH_CLIENT_SECRET: clientSecret,
    OAUTH_REDIRECT_URI: redirectUri,
  } = process.env;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "OAuth Error: One or more required environment variables (OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI) are not set.",
    );
  }

  const start = Date.now();
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  try {
    const res = await axios.post<GitHubAccessTokenResponse>(
      "https://github.com/login/oauth/access_token",
      params.toString(),
      {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        maxRedirects: 0,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      },
    );

    const body = res.data;
    const accessToken = body.access_token || null;

    if (!accessToken) {
      throw new Error(
        "OAuth Error: access_token missing from response: " +
          JSON.stringify(body),
      );
    }

    console.log("GitHub Authentication", `${Date.now() - start} ms`);
    return { accessToken, hasScope: !!body.scope };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`OAuth Error: ${err.response.status}`);
    }
    throw err;
  }
}
