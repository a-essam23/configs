return {
  {
    "mfussenegger/nvim-dap",
    config = function()
      local dap = require("dap")

      -- UI keymaps
      vim.keymap.set("n", "<leader>db", dap.toggle_breakpoint, { desc = "Toggle breakpoint" })
      vim.keymap.set("n", "<leader>dB", function()
        dap.set_breakpoint(vim.fn.input("Breakpoint condition: "))
      end, { desc = "Conditional breakpoint" })
      vim.keymap.set("n", "<leader>dc", dap.continue,    { desc = "Continue" })
      vim.keymap.set("n", "<leader>dC", dap.run_to_cursor, { desc = "Run to cursor" })
      vim.keymap.set("n", "<leader>do", dap.step_over,   { desc = "Step over" })
      vim.keymap.set("n", "<leader>di", dap.step_into,   { desc = "Step into" })
      vim.keymap.set("n", "<leader>dO", dap.step_out,    { desc = "Step out" })
      vim.keymap.set("n", "<leader>dr", dap.repl.open,   { desc = "Open REPL" })
      vim.keymap.set("n", "<leader>dl", dap.run_last,    { desc = "Run last" })

      -- DAP UI (optional: nicer UI for debugging)
      local ok, dapui = pcall(require, "dapui")
      if ok then
        dap.listeners.after.event_initialized["dapui_config"] = function() dapui.open() end
        dap.listeners.before.event_terminated["dapui_config"] = function() dapui.close() end
        dap.listeners.before.event_exited["dapui_config"] = function() dapui.close() end
      end
    end,
  },
  {
    "leoluz/nvim-dap-go",
    dependencies = { "mfussenegger/nvim-dap" },
    ft = "go",
    config = function()
      require("dap-go").setup({
        -- Automatically pick up delve if installed
        delve = {
          path = "dlv",
          initialize_timeout_sec = 20,
          port = "${port}",
        },
      })
    end,
  },
  {
    "rcarriga/nvim-dap-ui",
    dependencies = { "mfussenegger/nvim-dap", "nvim-neotest/nvim-nio" },
    config = function()
      require("dapui").setup()
    end,
  },
}
