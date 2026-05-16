return {
  "ray-x/go.nvim",
  dependencies = {
    "ray-x/guihua.lua",
    "nvim-treesitter/nvim-treesitter",
  },
  config = function()
    require("go").setup({
      -- Use the standard Go test runner
      test_runner = "go",
      -- Show test result in a floating window
      test_efm = "rich",
      -- Run gofumpt if available, fallback to gofmt
      gofmt = "gofumpt",
    })
  end,
  event = { "CmdlineEnter" },
  ft = { "go", "gomod" },
  build = ':lua require("go.install").update_all_sync()',
  -- Keymaps (only set when in Go files)
  keys = {
    { "<leader>tr", "<cmd>GoTest<cr>",       desc = "Run test at cursor" },
    { "<leader>tf", "<cmd>GoTestFunc<cr>",   desc = "Run current test function" },
    { "<leader>tp", "<cmd>GoTestPkg<cr>",    desc = "Run package tests" },
    { "<leader>tc", "<cmd>GoTestCompile<cr>", desc = "Compile test binary" },
    { "<leader>ta", "<cmd>GoAddTag<cr>",     desc = "Add struct tags" },
    { "<leader>tm", "<cmd>GoTagMod<cr>",     desc = "Modify struct tags" },
    { "<leader>ti", "<cmd>GoIfErr<cr>",      desc = "Generate if err != nil" },
    { "<leader>ts", "<cmd>GoFillStruct<cr>", desc = "Fill struct with defaults" },
  },
}
