return {
  "ellisonleao/gruvbox.nvim",
  lazy = false,
  priority = 1000,
  config = function()
    require("gruvbox").setup({
      terminal_colors = true,
      undercurl = true,
      underline = true,
      bold = true,
      italic = {
        strings = true,
        emphasis = true,
        comments = true,
        operators = false,
        folds = true,
      },
      strikethrough = true,
      invert_selection = false,
      invert_signs = false,
      invert_tabline = false,
      invert_intend_guides = false,
      inverse = true,
      contrast = "hard",
      palette_overrides = {},
      overrides = {
        -- Very subtle visual selection with blend for opacity
        Visual = { bg = "#665c54", blend = 20 },
        
        -- Line-level highlights (these are fine)
        DiffAdd = { bg = "#3b4430", blend = 30 },
        DiffChange = { bg = "#504935", blend = 25 },
        DiffDelete = { bg = "#442b2b", blend = 20 },
      },
      dim_inactive = false,
      transparent_mode = false,
    })
    vim.cmd("colorscheme gruvbox")
    
    -- Function to fix codediff highlights
    local function fix_codediff_highlights()
      -- Very subtle word-level highlights (barely visible)
      vim.api.nvim_set_hl(0, "CodeDiffCharInsert", { bg = "#3c4430", blend = 50 })
      vim.api.nvim_set_hl(0, "CodeDiffCharDelete", { bg = "#3c2b2b", blend = 50 })
      vim.api.nvim_set_hl(0, "CodeDiffCharChange", { bg = "#4c4430", blend = 50 })
      -- Line-level highlights
      vim.api.nvim_set_hl(0, "CodeDiffLineInsert", { bg = "#3b4430", blend = 30 })
      vim.api.nvim_set_hl(0, "CodeDiffLineDelete", { bg = "#442b2b", blend = 20 })
      vim.api.nvim_set_hl(0, "CodeDiffLineChange", { bg = "#504935", blend = 25 })
    end
    
    -- Run immediately
    fix_codediff_highlights()
    
    -- Also run after any buffer is entered (in case codediff sets them later)
    vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
      callback = fix_codediff_highlights,
    })
  end,
}
