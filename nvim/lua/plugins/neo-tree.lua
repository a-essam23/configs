return {
	"nvim-neo-tree/neo-tree.nvim",
	branch = "v3.x",
	dependencies = {
		"nvim-lua/plenary.nvim",
		"nvim-tree/nvim-web-devicons", -- file icons
		"MunifTanjim/nui.nvim",
	},
	keys = {
		{ "<leader>e", "<cmd>Neotree toggle<cr>", desc = "Toggle file explorer" },
		{ "<leader>o", "<cmd>Neotree focus<cr>",  desc = "Focus file explorer" },
	},
	opts = {
		filesystem = {
			follow_current_file = { enabled = true }, -- highlight the file you're editing
			use_libuv_file_watcher = true, -- auto-refresh on filesystem changes
		},
		window = {
			width = 35,
		},
	},
}
