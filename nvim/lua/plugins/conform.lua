return {
  "stevearc/conform.nvim",
  event = "BufWritePre",
  opts = {
    formatters_by_ft = {
      lua = { "stylua" },
      -- python = { "black" },
      -- javascript = { "prettier" },
      go = { "gofmt", "goimports" },
    },
    format_on_save = { timeout_ms = 500, lsp_format = "fallback" },
  },
}
