import { defineConfig } from "vitepress";

const SITE_URL = "https://ventus-software-solutions.github.io/agent-workboard/";
const REPO_URL = "https://github.com/ventus-software-solutions/agent-workboard";
const SOCIAL_IMAGE = `${REPO_URL.replace("github.com", "raw.githubusercontent.com")}/main/docs/assets/board.png`;

const SITE_DESCRIPTION =
  "A local-first kanban board for coordinating AI coding agents. Agents claim tasks over an HTTP API and MCP server; you steer the work from a browser UI. No account, no cloud, no telemetry.";

// Per-page meta descriptions live here rather than in markdown frontmatter, so
// the docs stay clean when read directly on GitHub.
const PAGE_DESCRIPTIONS = {
  "index.md": SITE_DESCRIPTION,
  "agent-protocol.md":
    "The Agent Workboard agent contract: how agents bootstrap instructions, take a slot, claim a task, report progress, and close work with evidence, over both MCP and HTTP.",
  "agent-spawning.md":
    "How to run a pool of AI coding agents against Agent Workboard: start the board, start a PM agent first, then spawn implementers, reviewers, and testers into configured slots.",
  "continuous-agent-prompts.md":
    "Copy-paste prompt templates for continuous AI coding agents that keep draining eligible work from the Agent Workboard board instead of stopping after a single task.",
  "architecture.md":
    "How Agent Workboard fits together: the React UI, Express HTTP API, SQLite-backed store, and stdio MCP server all operating on the same local board data.",
  "operator-guide.md":
    "Plain-language guide to operating Agent Workboard: projects, tasks, agents, capabilities, coordination, approvals, cleanup, integration status, and common recovery recipes.",
  "roadmap.md":
    "Direction and current non-goals for Agent Workboard: a credible local-first core first, public open-source launch second, hosted and team features only after that.",
  "releasing.md":
    "How an Agent Workboard release is cut: preflight checks, tagging, the GitHub release, and the container image published to GHCR."
};

function pageUrl(relativePath) {
  const path = relativePath
    .replace(/index\.md$/, "")
    .replace(/\.md$/, "")
    .replace(/^\/+/, "");
  return `${SITE_URL}${path}`;
}

export default defineConfig({
  title: "Agent Workboard",
  description: SITE_DESCRIPTION,
  base: "/agent-workboard/",
  lastUpdated: true,
  cleanUrls: true,
  appearance: "dark",

  sitemap: {
    hostname: SITE_URL
  },

  head: [
    [
      "meta",
      {
        name: "google-site-verification",
        content: "8-PB46iJ7WM95Fz3TPYh4hQu9iipsXszv4O3fj9XoaI"
      }
    ],
    ["meta", { name: "author", content: "Ventus Software Solutions" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Agent Workboard" }],
    ["meta", { property: "og:image", content: SOCIAL_IMAGE }],
    [
      "meta",
      {
        property: "og:image:alt",
        content:
          "The Agent Workboard board view, showing tasks across backlog, ready, in progress, review, testing, blocked, and done columns"
      }
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: SOCIAL_IMAGE }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "Agent Workboard",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Linux, macOS, Windows",
        description: SITE_DESCRIPTION,
        url: SITE_URL,
        codeRepository: REPO_URL,
        license: `${REPO_URL}/blob/main/LICENSE`,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        author: {
          "@type": "Organization",
          name: "Ventus Software Solutions",
          url: "https://ventus.works"
        }
      })
    ]
  ],

  transformPageData(pageData) {
    const url = pageUrl(pageData.relativePath);
    const description =
      pageData.frontmatter.description ??
      PAGE_DESCRIPTIONS[pageData.relativePath] ??
      SITE_DESCRIPTION;
    // The home page has no h1, so pageData.title is empty there; fall back to
    // the hero name and skip the " | Agent Workboard" suffix.
    const pageTitle =
      pageData.frontmatter.title || pageData.title || pageData.frontmatter.hero?.name;
    const title =
      pageTitle && pageTitle !== "Agent Workboard"
        ? `${pageTitle} | Agent Workboard`
        : "Agent Workboard";

    pageData.description = description;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }]
    );
  },

  themeConfig: {
    nav: [
      { text: "Operator Guide", link: "/operator-guide" },
      { text: "Agent Protocol", link: "/agent-protocol" },
      { text: "Architecture", link: "/architecture" },
      { text: "Roadmap", link: "/roadmap" },
      { text: "Repository", link: REPO_URL }
    ],

    sidebar: [
      {
        text: "Using The Board",
        items: [
          { text: "Operator Guide", link: "/operator-guide" }
        ]
      },
      {
        text: "Running Agents",
        items: [
          { text: "Agent Protocol", link: "/agent-protocol" },
          { text: "Agent Spawning", link: "/agent-spawning" },
          { text: "Continuous Agent Prompts", link: "/continuous-agent-prompts" }
        ]
      },
      {
        text: "Project",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Roadmap", link: "/roadmap" },
          { text: "Releasing", link: "/releasing" }
        ]
      },
      {
        text: "On GitHub",
        items: [
          { text: "README", link: `${REPO_URL}#readme` },
          { text: "Security", link: `${REPO_URL}/blob/main/SECURITY.md` },
          { text: "Contributing", link: `${REPO_URL}/blob/main/CONTRIBUTING.md` }
        ]
      }
    ],

    socialLinks: [{ icon: "github", link: REPO_URL }],

    search: {
      provider: "local"
    },

    editLink: {
      pattern: `${REPO_URL}/edit/main/docs/:path`,
      text: "Edit this page on GitHub"
    },

    footer: {
      message: "Released under the MIT License.",
      copyright:
        'Built by <a href="https://ventus.works">Ventus Software Solutions</a>'
    }
  }
});
