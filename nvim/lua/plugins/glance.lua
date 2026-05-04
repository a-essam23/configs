return {
  "dnlhc/glance.nvim",
  config = function()
    require("glance").setup({
      height = 18,
      border = {
        enable = true,
      },
    })
  end,
  keys = {
    { "<leader>pd", "<cmd>Glance definitions<cr>", desc = "Peek definition" },
    { "<leader>pt", "<cmd>Glance type_definitions<cr>", desc = "Peek type definition" },
    { "<leader>pr", "<cmd>Glance references<cr>", desc = "Peek references" },
    { "<leader>pi", "<cmd>Glance implementations<cr>", desc = "Peek implementations" },
  },
}
