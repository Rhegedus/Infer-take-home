/**
 * Browserless v2 expects launch options as base64 JSON in the `launch` query param.
 * Okta (and most carrier portals) require JavaScript — without this you get the
 * "Javascript is required" noscript page and automation cannot see the MFA form.
 */
export function browserlessWsWithLaunch(
  endpoint: string,
  launch: Record<string, unknown> = {}
): string {
  const url = new URL(endpoint);
  const prior = url.searchParams.get("launch");

  let merged: Record<string, unknown> = {
    javaScriptEnabled: true,
    ...launch,
  };

  if (prior) {
    try {
      const decoded = Buffer.from(prior, "base64").toString("utf8");
      merged = { ...JSON.parse(decoded), ...merged };
    } catch {
      try {
        merged = { ...JSON.parse(prior), ...merged };
      } catch {
        /* keep defaults */
      }
    }
  }

  url.searchParams.set(
    "launch",
    Buffer.from(JSON.stringify(merged)).toString("base64")
  );

  return url.toString();
}
