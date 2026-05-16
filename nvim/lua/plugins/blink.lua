return {
  "saghen/blink.cmp",
  version = "v0.*",
  opts = {
    keymap = { preset = "default", ["<Tab>"] = { "accept", "fallback" } },
    appearance = { use_nvim_cmp_as_default = true },
    sources = { default = { "lsp", "path", "snippets", "buffer" } },
  },
  opts_extend = { "sources.default" },
}
