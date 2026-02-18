import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

// Mock ALL tool registration imports
vi.mock('./accounts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./analytics.tool.js', () => ({ default: vi.fn() }));
vi.mock('./attachments.tool.js', () => ({ default: vi.fn() }));
vi.mock('./bulk.tool.js', () => ({ default: vi.fn() }));
vi.mock('./calendar.tool.js', () => ({ default: vi.fn() }));
vi.mock('./contacts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./drafts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./emails.tool.js', () => ({ default: vi.fn() }));
vi.mock('./folders.tool.js', () => ({ default: vi.fn() }));
vi.mock('./health.tool.js', () => ({ default: vi.fn() }));
vi.mock('./label.tool.js', () => ({ default: vi.fn() }));
vi.mock('./locate.tool.js', () => ({ default: vi.fn() }));
vi.mock('./mailboxes.tool.js', () => ({ default: vi.fn() }));
vi.mock('./manage.tool.js', () => ({ default: vi.fn() }));
vi.mock('./scheduler.tool.js', () => ({ default: vi.fn() }));
vi.mock('./send.tool.js', () => ({ default: vi.fn() }));
vi.mock('./templates.tool.js', () => ({
  registerTemplateReadTools: vi.fn(),
  registerTemplateWriteTools: vi.fn(),
}));
vi.mock('./thread.tool.js', () => ({ default: vi.fn() }));
vi.mock('./watcher.tool.js', () => ({ default: vi.fn() }));

import registerAccountsTools from './accounts.tool.js';
import registerBulkTools from './bulk.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerFolderTools from './folders.tool.js';
import registerLabelTools from './label.tool.js';
import registerManageTools from './manage.tool.js';
import registerSchedulerTools from './scheduler.tool.js';
import registerSendTools from './send.tool.js';
import { registerTemplateWriteTools } from './templates.tool.js';

function createConfig(readOnly: boolean): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly,
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      hooks: {
        onNewEmail: 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgencyThreshold: 'high',
          webhookUrl: '',
          webhookEvents: ['urgent', 'high'],
        },
      },
    },
    accounts: [],
  };
}

describe('registerAllTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all tools when readOnly is false', () => {
    registerAllTools(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      createConfig(false),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    // Read tools should always be registered
    expect(registerAccountsTools).toHaveBeenCalled();
    expect(registerEmailsTools).toHaveBeenCalled();
    // Write tools should be registered when NOT read-only
    expect(registerSendTools).toHaveBeenCalled();
    expect(registerManageTools).toHaveBeenCalled();
    expect(registerLabelTools).toHaveBeenCalled();
    expect(registerBulkTools).toHaveBeenCalled();
    expect(registerDraftTools).toHaveBeenCalled();
    expect(registerFolderTools).toHaveBeenCalled();
    expect(registerTemplateWriteTools).toHaveBeenCalled();
    expect(registerSchedulerTools).toHaveBeenCalled();
  });

  it('skips write tools when readOnly is true', () => {
    registerAllTools(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      createConfig(true),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    // Read tools should still be registered
    expect(registerAccountsTools).toHaveBeenCalled();
    expect(registerEmailsTools).toHaveBeenCalled();
    // Write tools should NOT be registered
    expect(registerSendTools).not.toHaveBeenCalled();
    expect(registerManageTools).not.toHaveBeenCalled();
    expect(registerLabelTools).not.toHaveBeenCalled();
    expect(registerBulkTools).not.toHaveBeenCalled();
    expect(registerDraftTools).not.toHaveBeenCalled();
    expect(registerFolderTools).not.toHaveBeenCalled();
    expect(registerTemplateWriteTools).not.toHaveBeenCalled();
    expect(registerSchedulerTools).not.toHaveBeenCalled();
  });
});
