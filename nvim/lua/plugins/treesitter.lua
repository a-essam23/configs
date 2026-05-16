return {
  "nvim-treesitter/nvim-treesitter",
  branch = "master",
  build = ":TSUpdate",
  config = function()
    require("nvim-treesitter.configs").setup({
      ensure_installed = {
        "lua",
        "vim",
        "vimdoc",
        "bash",
        "json",
        "yaml",
        "markdown",
        "markdown_inline",
        -- Go
        "go",
        "gomod",
        "gowork",
        -- templ
        "templ",
      },
      auto_install = true,
      highlight = {
        enable = true,
        disable = { "markdown" },
      },
      indent = { enable = true },
    })

    -- Disable treesitter for markdown and use built-in syntax
    vim.api.nvim_create_autocmd("FileType", {
      pattern = "markdown",
      callback = function()
        vim.treesitter.stop()
      end,
    })
  end,
}
