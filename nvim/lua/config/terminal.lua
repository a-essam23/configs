local Terminal = {}

local terminal_buffer
local terminal_window

local function is_valid_buffer()
  return terminal_buffer and vim.api.nvim_buf_is_valid(terminal_buffer)
end

local function is_valid_window()
  return terminal_window and vim.api.nvim_win_is_valid(terminal_window)
end

local function has_running_terminal()
  if not is_valid_buffer() or vim.bo[terminal_buffer].buftype ~= "terminal" then
    return false
  end

  local channel = vim.bo[terminal_buffer].channel
  return channel > 0 and vim.fn.jobwait({ channel }, 0)[1] == -1
end

local function window_config()
  local width = math.max(20, math.floor(vim.o.columns * 0.8))
  local height = math.max(5, math.floor(vim.o.lines * 0.8))

  return {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    style = "minimal",
    border = "rounded",
  }
end

local function set_terminal_keymaps()
  for _, key in ipairs({ "<C-/>", "<C-_>" }) do
    vim.keymap.set("t", key, Terminal.toggle, {
      buffer = terminal_buffer,
      desc = "Hide terminal",
    })
  end
end

local function show_terminal()
  if not has_running_terminal() then
    terminal_buffer = vim.api.nvim_create_buf(false, true)
    vim.bo[terminal_buffer].bufhidden = "hide"
    vim.bo[terminal_buffer].swapfile = false
  end

  terminal_window = vim.api.nvim_open_win(terminal_buffer, true, window_config())

  if vim.bo[terminal_buffer].buftype ~= "terminal" then
    vim.cmd.terminal()
  end

  set_terminal_keymaps()
  vim.cmd.startinsert()
end

function Terminal.toggle()
  if is_valid_window() then
    local is_current_tab = vim.api.nvim_win_get_tabpage(terminal_window) == vim.api.nvim_get_current_tabpage()
    if is_current_tab and has_running_terminal() then
      vim.api.nvim_win_close(terminal_window, true)
      terminal_window = nil
      return
    end

    vim.api.nvim_win_close(terminal_window, true)
    terminal_window = nil
  end

  show_terminal()
end

vim.api.nvim_create_user_command("SlimTermToggle", Terminal.toggle, {
  desc = "Toggle floating terminal",
})

vim.api.nvim_create_autocmd("VimResized", {
  callback = function()
    if is_valid_window() then
      vim.api.nvim_win_set_config(terminal_window, window_config())
    end
  end,
})

vim.keymap.set("n", "<C-/>", Terminal.toggle, { desc = "Toggle terminal" })

return Terminal
