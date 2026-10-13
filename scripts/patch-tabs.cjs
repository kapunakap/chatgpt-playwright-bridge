const fs = require('fs');

const file = '/app/node_modules/playwright-core/lib/coreBundle.js';
let source = fs.readFileSync(file, 'utf8');

const replacements = [
  [
`      async ensureBrowserContext() {
        if (this._browserContextPromise)
          return this._browserContextPromise;`,
`      async ensureBrowserContext() {
        if (this._browserContextPromise) {
          const context = await this._browserContextPromise;
          const preferredIndex = globalThis.__chatgptMcpCurrentTabIndex;
          if (Number.isInteger(preferredIndex) && this._tabs[preferredIndex])
            this._setCurrentTab(this._tabs[preferredIndex]);
          return context;
        }`
  ],
  [
`      async newTab() {
        const browserContext = await this.ensureBrowserContext();
        const page = await browserContext.newPage();
        this._setCurrentTab(this._tabs.find((t) => t.page === page));
        return this._currentTab;
      }`,
`      async newTab() {
        const browserContext = await this.ensureBrowserContext();
        const page = await browserContext.newPage();
        this._setCurrentTab(this._tabs.find((t) => t.page === page));
        globalThis.__chatgptMcpCurrentTabIndex = this._tabs.indexOf(this._currentTab);
        return this._currentTab;
      }`
  ],
  [
`      async selectTab(index) {
        const tab2 = this._tabs[index];
        if (!tab2)
          throw new Error(\`Tab \${index} not found\`);
        await tab2.page.bringToFront();
        await tab2.updateWebMCPTools();
        this._setCurrentTab(tab2);
        return tab2;
      }`,
`      async selectTab(index) {
        await this.ensureBrowserContext();
        const tab2 = this._tabs[index];
        if (!tab2)
          throw new Error(\`Tab \${index} not found\`);
        await tab2.page.bringToFront();
        await tab2.updateWebMCPTools();
        this._setCurrentTab(tab2);
        globalThis.__chatgptMcpCurrentTabIndex = index;
        return tab2;
      }`
  ],
  [
`      async closeTab(index) {
        const tab2 = index === void 0 ? this._currentTab : this._tabs[index];
        if (!tab2)
          throw new Error(\`Tab \${index} not found\`);
        const url3 = tab2.page.url();
        await tab2.page.close();
        return url3;
      }`,
`      async closeTab(index) {
        await this.ensureBrowserContext();
        const tab2 = index === void 0 ? this._currentTab : this._tabs[index];
        if (!tab2)
          throw new Error(\`Tab \${index} not found\`);
        const url3 = tab2.page.url();
        await tab2.page.close();
        const currentIndex = this._tabs.indexOf(this._currentTab);
        if (currentIndex >= 0)
          globalThis.__chatgptMcpCurrentTabIndex = currentIndex;
        else
          delete globalThis.__chatgptMcpCurrentTabIndex;
        return url3;
      }`
  ],
  [
`        this._disposables.push(eventsHelper.addEventListener(browserContext, "page", (page) => this._onPageCreated(page)));
        return browserContext;`,
`        this._disposables.push(eventsHelper.addEventListener(browserContext, "page", (page) => this._onPageCreated(page)));
        const preferredIndex = globalThis.__chatgptMcpCurrentTabIndex;
        if (Number.isInteger(preferredIndex) && this._tabs[preferredIndex])
          this._setCurrentTab(this._tabs[preferredIndex]);
        if (this._currentTab)
          globalThis.__chatgptMcpCurrentTabIndex = this._tabs.indexOf(this._currentTab);
        return browserContext;`
  ]
];

for (const [before, after] of replacements) {
  if (source.includes(after))
    continue;
  if (!source.includes(before))
    throw new Error('Playwright MCP layout changed; refusing to apply compatibility patch.');
  source = source.replace(before, after);
}

fs.writeFileSync(file, source);
console.log('Applied ChatGPT shared-tab compatibility patch v3.');
