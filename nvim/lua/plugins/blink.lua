return {
  "saghen/blink.cmp",
  version = "v0.*",
  opts = {
    keymap = { preset = "default" },
    appearance = { use_nvim_cmp_as_default = true },
    sources = { default = { "lsp", "path", "snippets", "buffer" } },
  },
  opts_extend = { "sources.default" },
}
