return {
  "saghen/blink.cmp",
  version = "v0.*",
  opts = {
    keymap = {
      preset = "default",
      ["<Tab>"] = { "accept", "fallback" },
      ["<C-.>"] = { "show", "show_documentation", "hide_documentation" },
    },
    appearance = { use_nvim_cmp_as_default = true },
    sources = { default = { "lsp", "path", "snippets", "buffer" } },
  },
  opts_extend = { "sources.default" },
}
