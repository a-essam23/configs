return {
	"nvim-treesitter/nvim-treesitter",
	branch = "master",
	build = ":TSUpdate",
	config = function()
		require("nvim-treesitter.configs").setup({
			ensure_installed = { "lua", "vim", "vimdoc", "bash", "json", "yaml", "markdown", "markdown_inline" },
			auto_install = true,
			highlight = {
				enable = true,
				-- Disable highlighting for markdown to avoid the bug
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
