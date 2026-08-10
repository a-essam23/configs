return {
  "nvim-treesitter/nvim-treesitter",
  branch = "main",
  lazy = false,
  build = ":TSUpdate",
  config = function()
    local languages = {
      "lua",
      "vim",
      "vimdoc",
      "bash",
      "json",
      "yaml",
      -- Go
      "go",
      "gomod",
      "gowork",
      -- templ
      "templ",
    }

    require("nvim-treesitter").setup()
    require("nvim-treesitter").install(languages)

    vim.api.nvim_create_autocmd("FileType", {
      pattern = languages,
      callback = function(args)
        vim.treesitter.start(args.buf)
        vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
      end,
    })

    vim.api.nvim_create_autocmd("FileType", {
      pattern = "markdown",
      callback = function(args)
        vim.treesitter.stop(args.buf)
      end,
    })
  end,
}
