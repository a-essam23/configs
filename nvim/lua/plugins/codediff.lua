return {
	"esmuellert/codediff.nvim",
	cmd = "CodeDiff",
	keys = {
		{ "<leader>gd", "<cmd>CodeDiff<cr>",         desc = "Code diff (changed files)" },
		{ "<leader>gh", "<cmd>CodeDiff history<cr>", desc = "Commit history" },
		{ "<leader>gp", "<cmd>CodeDiff main...<cr>", desc = "PR diff vs main" },
	},
	opts = {},
}
