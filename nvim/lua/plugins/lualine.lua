return {
  "nvim-lualine/lualine.nvim",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  opts = {
    sections = {
      lualine_x = {
        {
          "diagnostics",
          sources = { "nvim_diagnostic" },
          symbols = { error = "E:", warn = "W:", info = "I:", hint = "H:" },
        },
        "encoding",
        "fileformat",
        "filetype",
      },
    },
  },
}
