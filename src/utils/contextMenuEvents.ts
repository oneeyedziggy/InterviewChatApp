export const CONTEXT_MENU_CLOSE_EVENT = 'app:close-context-menus';

export const closeOtherContextMenus = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CONTEXT_MENU_CLOSE_EVENT));
};
