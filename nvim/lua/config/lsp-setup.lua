-- Native Neovim 0.11+ LSP configuration using vim.lsp.config
-- Called from init.lua

-- Associate .templ files with the templ filetype (so LSP + treesitter attach)
vim.filetype.add({
  extension = {
    templ = "templ",
  },
})

-- Diagnostics keymaps (available regardless of LSP)
vim.keymap.set("n", "<leader>de", vim.diagnostic.open_float, { desc = "Show error message" })
vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, { desc = "Previous diagnostic" })
vim.keymap.set("n", "]d", vim.diagnostic.goto_next, { desc = "Next diagnostic" })
vim.keymap.set("n", "<leader>q", vim.diagnostic.setloclist, { desc = "List all diagnostics" })

-- LSP keymaps (set on every LSP attach)
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local buf = args.buf
    local map = function(keys, func, desc)
      vim.keymap.set("n", keys, func, { buffer = buf, desc = desc })
    end
    map("gd", vim.lsp.buf.definition, "Go to definition")
    map("gr", vim.lsp.buf.references, "Find references")
    map("K",  vim.lsp.buf.hover,      "Hover docs")
    map("<leader>rn", vim.lsp.buf.rename, "Rename symbol")
    map("<leader>ca", vim.lsp.buf.code_action, "Code action")
    map("gy", vim.lsp.buf.type_definition, "Go to type definition")
  end,
})

-- gopls
vim.lsp.config.gopls = {
  cmd = { "gopls" },
  filetypes = { "go", "gomod" },
  root_markers = { "go.mod", ".git" },
  settings = {
    gopls = {
      analyses = {
        unusedparams = true,
        shadow = true,
        nilness = true,
      },
      staticcheck = true,
      hints = {
        assignVariableTypes = true,
        compositeLiteralFields = true,
        constantValues = true,
        functionTypeParameters = true,
        parameterNames = true,
        rangeVariableTypes = true,
      },
    },
  },
}
vim.lsp.enable("gopls")

-- templ (LSP is built into the `templ` binary itself — no separate mason package)
vim.lsp.config.templ = {
  cmd = { "templ", "lsp" },
  filetypes = { "templ" },
  root_markers = { "go.mod", ".git" },
}
vim.lsp.enable("templ")

-- lua_ls (for editing Neovim config itself)
vim.lsp.config.lua_ls = {
  cmd = { "lua-language-server" },
  filetypes = { "lua" },
  root_markers = { ".luarc.json", ".git" },
  settings = {
    Lua = {
      runtime = { version = "LuaJIT" },
      diagnostics = { globals = { "vim" } },
    },
  },
}
vim.lsp.enable("lua_ls")
