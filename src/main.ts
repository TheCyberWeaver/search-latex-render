import {
  MarkdownRenderer,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { parseMathDocument, recoverSearchExcerpt, type ParsedMathDocument, type RecoveryResult } from "./math-recovery";

interface SearchLatexRenderSettings {
  enabled: boolean;
  debounceMs: number;
  contextChars: number;
  maxRenderedLineLength: number;
  maxBlockLength: number;
}

interface CachedMathDocument {
  mtime: number;
  parsed: ParsedMathDocument;
}

const DEFAULT_SETTINGS: SearchLatexRenderSettings = {
  enabled: true,
  debounceMs: 40,
  contextChars: 64,
  maxRenderedLineLength: 400,
  maxBlockLength: 3000,
};

class SearchLatexRenderSettingTab extends PluginSettingTab {
  constructor(app: Plugin["app"], private readonly plugin: SearchLatexRenderPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enable search math rendering")
      .setDesc("Render inline and block LaTeX inside the Search view.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshControllers();
        }),
      );

    new Setting(containerEl)
      .setName("Debounce")
      .setDesc("Delay before re-processing updated search results.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) {
            return;
          }

          this.plugin.settings.debounceMs = parsed;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Context characters")
      .setDesc("Extra plain-text context to keep around a recovered inline formula.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.contextChars)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 8) {
            return;
          }

          this.plugin.settings.contextChars = parsed;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max rendered line length")
      .setDesc("Trim very long source lines before rendering.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxRenderedLineLength)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 80) {
            return;
          }

          this.plugin.settings.maxRenderedLineLength = parsed;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max block length")
      .setDesc("Skip extremely large recovered $$ blocks for performance.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxBlockLength)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 120) {
            return;
          }

          this.plugin.settings.maxBlockLength = parsed;
          await this.plugin.saveSettings();
        }),
      );
  }
}

class SearchResultController {
  private observer: MutationObserver | null = null;
  private timer: number | null = null;
  private isApplyingChanges = false;

  constructor(private readonly plugin: SearchLatexRenderPlugin, private readonly leaf: WorkspaceLeaf) {}

  start(): void {
    const container = this.getSearchContainer();
    if (!container) {
      return;
    }

    this.observer = new MutationObserver(() => {
      if (this.isApplyingChanges) {
        return;
      }

      this.scheduleProcess();
    });
    this.observer.observe(container, { childList: true, subtree: true });
    this.scheduleProcess();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    this.restoreRenderedMatches();
    this.observer?.disconnect();
    this.observer = null;
  }

  scheduleProcess(): void {
    if (!this.plugin.settings.enabled) {
      this.restoreRenderedMatches();
      return;
    }

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }

    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.processNow();
    }, this.plugin.settings.debounceMs);
  }

  async processNow(): Promise<void> {
    if (!this.plugin.settings.enabled) {
      this.restoreRenderedMatches();
      return;
    }

    const container = this.getSearchContainer();
    if (!container) {
      return;
    }

    const matches = this.findMatchElements(container);
    if (matches.length === 0) {
      return;
    }

    this.isApplyingChanges = true;
    try {
      for (const matchEl of matches) {
        this.restoreElement(matchEl);

        const file = this.resolveFile(matchEl);
        const lineNumber = this.extractLineNumber(matchEl);
        const snippet = this.extractVisibleSnippet(matchEl);
        if (!snippet) {
          continue;
        }

        const result = await this.buildRecovery(file, lineNumber, snippet);
        if (!result) {
          continue;
        }

        await this.renderResult(matchEl, file, result);
      }
    } finally {
      window.setTimeout(() => {
        this.isApplyingChanges = false;
      }, 0);
    }
  }

  private getSearchContainer(): HTMLElement | null {
    const view = this.leaf.view as { containerEl?: HTMLElement };
    return view.containerEl ?? null;
  }

  private findMatchElements(container: HTMLElement): HTMLElement[] {
    const primary = Array.from(container.querySelectorAll(".search-result-file-match")).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    if (primary.length > 0) {
      return primary;
    }

    return Array.from(container.querySelectorAll(".search-result-file-match-line")).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
  }

  private restoreRenderedMatches(): void {
    const container = this.getSearchContainer();
    if (!container) {
      return;
    }

    container.querySelectorAll<HTMLElement>("[data-slrx-rendered='true']").forEach((matchEl) => {
      this.restoreElement(matchEl);
    });
  }

  private captureOriginalHtml(matchEl: HTMLElement): void {
    if (!matchEl.dataset.slrxOriginalHtml) {
      matchEl.dataset.slrxOriginalHtml = matchEl.innerHTML;
    }
  }

  private restoreElement(matchEl: HTMLElement): void {
    const originalHtml = matchEl.dataset.slrxOriginalHtml;
    if (!originalHtml) {
      return;
    }

    matchEl.innerHTML = originalHtml;
    delete matchEl.dataset.slrxOriginalHtml;
    delete matchEl.dataset.slrxRendered;
  }

  private extractLineNumber(matchEl: HTMLElement): number | null {
    const lineNumberText =
      matchEl.querySelector(".search-result-file-match-line-number")?.textContent ?? matchEl.textContent ?? "";
    const match = lineNumberText.match(/^\s*(\d+)\b/);
    if (!match) {
      return null;
    }

    const value = Number(match[1]);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  private extractVisibleSnippet(matchEl: HTMLElement): string {
    const clone = matchEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".search-result-file-match-line-number, .slrx-rendered-snippet").forEach((node) => node.remove());
    return (clone.textContent ?? "").replace(/\u00a0/g, " ").replace(/\r/g, "").trim();
  }

  private resolveFile(matchEl: HTMLElement): TFile | null {
    const pathCandidates = new Set<string>();
    const closestPath = matchEl.closest<HTMLElement>("[data-path]")?.dataset.path;
    if (closestPath) {
      pathCandidates.add(closestPath);
    }

    const fileContainer = matchEl.closest(".search-result-file");
    const titleEl = fileContainer?.querySelector<HTMLElement>(".search-result-file-title");
    const nestedPath = fileContainer?.querySelector<HTMLElement>("[data-path]")?.dataset.path;
    if (nestedPath) {
      pathCandidates.add(nestedPath);
    }

    const titlePath = titleEl?.dataset.path;
    if (titlePath) {
      pathCandidates.add(titlePath);
    }

    for (const path of pathCandidates) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        return file;
      }
    }

    const titleText = titleEl?.textContent?.trim();
    if (!titleText) {
      return null;
    }

    const destination = this.plugin.app.metadataCache.getFirstLinkpathDest(titleText, "");
    return destination instanceof TFile ? destination : null;
  }

  private async buildRecovery(
    file: TFile | null,
    lineNumber: number | null,
    snippet: string,
  ): Promise<RecoveryResult | null> {
    if (!file) {
      if (!snippet.includes("$") && !/[\\^_{}]/.test(snippet)) {
        return null;
      }

      return recoverSearchExcerpt(parseMathDocument(snippet), {
        visibleSnippet: snippet,
        contextChars: this.plugin.settings.contextChars,
        maxRenderedLineLength: this.plugin.settings.maxRenderedLineLength,
        maxBlockLength: this.plugin.settings.maxBlockLength,
      });
    }

    const parsed = await this.plugin.getParsedDocument(file);
    return recoverSearchExcerpt(parsed, {
      lineNumber,
      visibleSnippet: snippet,
      contextChars: this.plugin.settings.contextChars,
      maxRenderedLineLength: this.plugin.settings.maxRenderedLineLength,
      maxBlockLength: this.plugin.settings.maxBlockLength,
    });
  }

  private async renderResult(matchEl: HTMLElement, file: TFile | null, result: RecoveryResult): Promise<void> {
    this.captureOriginalHtml(matchEl);

    const lineNumberClone = matchEl.querySelector(".search-result-file-match-line-number")?.cloneNode(true);
    matchEl.innerHTML = "";

    if (lineNumberClone instanceof Node) {
      matchEl.appendChild(lineNumberClone);
    }

    const host = document.createElement("div");
    host.className = "slrx-rendered-snippet";
    host.dataset.recovered = result.recoveredFromFile ? "true" : "false";
    matchEl.appendChild(host);
    await renderMixedMath(this.plugin, result.excerpt, host, file?.path ?? "");
    matchEl.dataset.slrxRendered = "true";
  }
}

async function renderMixedMath(
  plugin: Plugin,
  source: string,
  container: HTMLElement,
  sourcePath: string,
): Promise<void> {
  const parsed = parseMathDocument(source);
  let cursor = 0;

  for (const segment of parsed.mathSegments) {
    if (segment.start > cursor) {
      container.appendChild(document.createTextNode(source.slice(cursor, segment.start)));
    }

    const mathHost = document.createElement("span");
    mathHost.className = segment.type === "block" ? "math math-block" : "math math-inline";
    container.appendChild(mathHost);
    await MarkdownRenderer.render(plugin.app, segment.raw, mathHost, sourcePath, plugin);
    unwrapParagraph(mathHost);
    cursor = segment.end;
  }

  if (cursor < source.length) {
    container.appendChild(document.createTextNode(source.slice(cursor)));
  }
}

function unwrapParagraph(container: HTMLElement): void {
  if (container.children.length !== 1) {
    return;
  }

  const onlyChild = container.firstElementChild;
  if (!(onlyChild instanceof HTMLElement) || onlyChild.tagName !== "P") {
    return;
  }

  while (onlyChild.firstChild) {
    container.appendChild(onlyChild.firstChild);
  }
  onlyChild.remove();
}

export default class SearchLatexRenderPlugin extends Plugin {
  settings: SearchLatexRenderSettings = DEFAULT_SETTINGS;
  private readonly controllers = new Map<WorkspaceLeaf, SearchResultController>();
  private readonly parsedDocumentCache = new Map<string, CachedMathDocument>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SearchLatexRenderSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshControllers()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshControllers()));
    this.registerEvent(this.app.vault.on("modify", (file) => this.invalidateCache(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.invalidateCache(file)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.invalidateCache(oldPath);
        this.invalidateCache(file);
      }),
    );

    this.addCommand({
      id: "toggle-search-latex-render",
      name: "Toggle search LaTeX rendering",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        this.refreshControllers();
      },
    });

    this.app.workspace.onLayoutReady(() => this.refreshControllers());
  }

  onunload(): void {
    this.detachAllControllers();
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async getParsedDocument(file: TFile): Promise<ParsedMathDocument> {
    const cached = this.parsedDocumentCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) {
      return cached.parsed;
    }

    const text = await this.app.vault.cachedRead(file);
    const parsed = parseMathDocument(text);
    this.parsedDocumentCache.set(file.path, { mtime: file.stat.mtime, parsed });
    return parsed;
  }

  refreshControllers(): void {
    if (!this.settings.enabled) {
      this.detachAllControllers();
      return;
    }

    const activeLeaves = new Set(this.app.workspace.getLeavesOfType("search"));
    for (const leaf of activeLeaves) {
      if (this.controllers.has(leaf)) {
        continue;
      }

      const controller = new SearchResultController(this, leaf);
      this.controllers.set(leaf, controller);
      controller.start();
    }

    for (const [leaf, controller] of this.controllers) {
      if (activeLeaves.has(leaf)) {
        continue;
      }

      controller.stop();
      this.controllers.delete(leaf);
    }
  }

  private detachAllControllers(): void {
    for (const controller of this.controllers.values()) {
      controller.stop();
    }
    this.controllers.clear();
  }

  private invalidateCache(file: TAbstractFile | string): void {
    const path = typeof file === "string" ? file : file.path;
    this.parsedDocumentCache.delete(path);
  }
}
