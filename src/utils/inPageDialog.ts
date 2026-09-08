const DIALOG_EVENT_NAME = 'app-inpage-dialog-request';

type DialogKind = 'alert' | 'confirm';

type DialogRequestDetail = {
  id: string;
  kind: DialogKind;
  title: string;
  message: string;
};

const confirmResolvers = new Map<string, (value: boolean) => void>();

const randomHex = (bytes = 16): string => {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Secure randomness unavailable');
  }
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const createDialogID = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `dialog:${Date.now()}:${randomHex(16)}`;
};

const dispatchDialog = (detail: DialogRequestDetail): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DialogRequestDetail>(DIALOG_EVENT_NAME, { detail }),
  );
};

export const showInPageAlert = (message: string, title = 'Notice'): void => {
  dispatchDialog({
    id: createDialogID(),
    kind: 'alert',
    title,
    message,
  });
};

export const showInPageConfirm = (
  message: string,
  title = 'Please Confirm',
): Promise<boolean> => {
  const id = createDialogID();
  return new Promise<boolean>((resolve) => {
    confirmResolvers.set(id, resolve);
    dispatchDialog({
      id,
      kind: 'confirm',
      title,
      message,
    });
  });
};

export const resolveInPageConfirm = (id: string, value: boolean): void => {
  const resolver = confirmResolvers.get(id);
  if (!resolver) {
    return;
  }
  confirmResolvers.delete(id);
  resolver(value);
};

export type InPageDialogRequest = DialogRequestDetail;
export { DIALOG_EVENT_NAME };
