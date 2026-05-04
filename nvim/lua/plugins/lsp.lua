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
        ensure_installed = { "lua_ls", "gopls" }, -- add servers like "pyright", "ts_ls", "rust_analyzer"
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
      { "gy", vim.lsp.buf.type_definition, desc = "Go to type definition" },
    },
    config = function()
      -- Diagnostics keymaps (always available)
      vim.keymap.set("n", "<leader>de", vim.diagnostic.open_float, { desc = "Show error message" })
      vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, { desc = "Previous diagnostic" })
      vim.keymap.set("n", "]d", vim.diagnostic.goto_next, { desc = "Next diagnostic" })
      vim.keymap.set("n", "<leader>q", vim.diagnostic.setloclist, { desc = "List all diagnostics" })
    end,
  },
}
