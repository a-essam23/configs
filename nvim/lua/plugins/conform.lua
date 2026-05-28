return {
  "stevearc/conform.nvim",
  event = "BufWritePre",
  opts = {
    formatters_by_ft = {
      lua = { "stylua" },
      go = { "gofmt", "goimports" },
      templ = { "templ" },
    },

    format_on_save = { timeout_ms = 500, lsp_format = "fallback" },
  },
}
