return {
	"afonsofrancof/worktrees.nvim",
	event = "VeryLazy",
	opts = {
		-- base_path is relative to the git *common dir* (<repo>/.git), so ".."
		-- is the repo root, not the parent directory. Worktrees land at
		-- <repo>/.worktrees/<branch>. Because common-dir is stable across
		-- linked worktrees, this resolves the same from any worktree.
		base_path = "..",
		path_template = ".worktrees/{branch}",
		mappings = {
			create = "<leader>wtc",
			switch = "<leader>wts",
			delete = "<leader>wtd",
		},
		-- Signature is (from_path, to_path).
		on_switch = function(_, to)
			-- codediff resolves its git root per-invocation, so a fresh
			-- :CodeDiff picks up the new worktree automatically. Existing
			-- explorer tabs keep their old root and file watcher, so only
			-- reopen if a session was actually open.
			local ok, accessors = pcall(require, "codediff.ui.lifecycle.accessors")
			local had_session = false
			if ok then
				for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
					if accessors.get_session(tab) then
						had_session = true
						break
					end
				end
			end
			if had_session then
				vim.schedule(function()
					vim.cmd("CodeDiff")
				end)
			end
			vim.notify("worktree: " .. to, vim.log.levels.INFO)
		end,
	},
}
