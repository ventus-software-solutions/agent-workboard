import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agent Workboard",
  description:
    "A local-first kanban board for coordinating AI coding agents, with an HTTP API and an MCP server.",
  base: "/agent-workboard/",
  lastUpdated: true,
  cleanUrls: true,
  appearance: "dark",

  head: [
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Agent Workboard" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A local-first kanban board for coordinating AI coding agents. No account, no cloud, no telemetry."
      }
    ],
    [
      "meta",
      {
        property: "og:image",
        content:
          "https://raw.githubusercontent.com/ventus-software-solutions/agent-workboard/main/docs/assets/board.png"
      }
    ]
  ],

  themeConfig: {
    nav: [
      { text: "Agent Protocol", link: "/agent-protocol" },
      { text: "Architecture", link: "/architecture" },
      { text: "Roadmap", link: "/roadmap" },
      {
        text: "Repository",
        link: "https://github.com/ventus-software-solutions/agent-workboard"
      }
    ],

    sidebar: [
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
          {
            text: "README",
            link: "https://github.com/ventus-software-solutions/agent-workboard#readme"
          },
          {
            text: "Security",
            link: "https://github.com/ventus-software-solutions/agent-workboard/blob/main/SECURITY.md"
          },
          {
            text: "Contributing",
            link: "https://github.com/ventus-software-solutions/agent-workboard/blob/main/CONTRIBUTING.md"
          }
        ]
      }
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/ventus-software-solutions/agent-workboard"
      }
    ],

    search: {
      provider: "local"
    },

    editLink: {
      pattern:
        "https://github.com/ventus-software-solutions/agent-workboard/edit/main/docs/:path",
      text: "Edit this page on GitHub"
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © Ventus Software Solutions"
    }
  }
});
