return {
  {
    "mason-org/mason.nvim",
    config = function() require("mason").setup() end,
  },
  {
    "mason-org/mason-lspconfig.nvim",
    dependencies = { "mason-org/mason.nvim", "neovim/nvim-lspconfig" },
    config = function()
      require("mason-lspconfig").setup({
        ensure_installed = { "lua_ls" }, -- add servers like "pyright", "ts_ls", "gopls", "rust_analyzer"
      })
    end,
  },
  {
    "neovim/nvim-lspconfig",
    keys = {
      { "gd", vim.lsp.buf.definition, desc = "Go to definition" },
      { "gr", vim.lsp.buf.references, desc = "Find references" },
      { "K",  vim.lsp.buf.hover,      desc = "Hover docs" },
      { "<leader>rn", vim.lsp.buf.rename, desc = "Rename symbol" },
      { "<leader>ca", vim.lsp.buf.code_action, desc = "Code action" },
    },
  },
}
