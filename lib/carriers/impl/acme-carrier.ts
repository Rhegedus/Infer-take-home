import { Page } from "puppeteer-core";
import { BaseCarrier } from "../base-carrier";
import { DocumentResult } from "../types";

/**
 * AcmeCarrier — example concrete implementation.
 *
 * Replace selectors / URLs with real values for your target portal.
 */
export class AcmeCarrier extends BaseCarrier {
  readonly carrierId = "acme";

  // ─── Optional page config ─────────────────────────────────────────────────

  protected override async configurePage(page: Page): Promise<void> {
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  }

  // ─── Login ────────────────────────────────────────────────────────────────

  protected async login(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void> {
    await page.goto("https://portal.acme-insurance.example/login", {
      waitUntil: "networkidle2",
    });

    await page.type("#username", credentials.username);
    await page.type("#password", credentials.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click("#login-btn"),
    ]);
  }

  // ─── MFA ──────────────────────────────────────────────────────────────────

  protected async triggerMfa(page: Page): Promise<void> {
    // Click "Send me a code" if the portal requires an explicit trigger
    await page.waitForSelector("#send-mfa-btn", { timeout: 15_000 });
    await page.click("#send-mfa-btn");
  }

  protected async submitMfaInBrowser(page: Page, code: string): Promise<void> {
    await page.waitForSelector("#mfa-input", { timeout: 15_000 });
    await page.type("#mfa-input", code);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click("#mfa-submit-btn"),
    ]);
  }

  // ─── Document Fetching ────────────────────────────────────────────────────

  protected async fetchDocuments(
    page: Page
  ): Promise<DocumentResult["documents"]> {
    await page.goto("https://portal.acme-insurance.example/documents", {
      waitUntil: "networkidle2",
    });

    // Example: collect download links, fetch each as a Buffer
    const links = await page.$$eval<string[]>(
      "a[data-doc-type]",
      (els) => els.map((el) => (el as HTMLAnchorElement).href)
    );

    const docs: DocumentResult["documents"] = [];

    for (const href of links) {
      const response = await page.goto(href, { waitUntil: "networkidle2" });
      if (!response?.ok()) continue;

      const buffer = Buffer.from(await response.buffer());
      const filename = href.split("/").pop() ?? "document.pdf";

      docs.push({
        type:     "UNKNOWN",
        filename,
        mimeType: response.headers()["content-type"] ?? "application/octet-stream",
        data:     buffer,
      });
    }

    return docs;
  }
}
