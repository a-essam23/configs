return {
	"folke/which-key.nvim",
	event = "VeryLazy",
	opts = {
		triggers = {
			{ "<auto>", mode = "nxso" },
		},
		disable = {
			ft = { "TelescopePrompt", "neo-tree" },
			bt = { "terminal" },
		},
	},
	keys = {
		{ "<leader>?", function() require("which-key").show({ global = false }) end, desc = "Buffer keymaps" },
		{ "<leader>", group = "Leader" },
	},
}
