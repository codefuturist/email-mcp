/**
 * Notification management subcommands.
 *
 * - notify test     Send a test desktop notification
 * - notify status   Check platform notification support
 */

import { confirm, intro, isCancel, log, outro, spinner as p_spinner, select } from '@clack/prompts';

import NotifierService from '../services/notifier.service.js';
import ensureInteractive from './guard.js';

function printNotifyUsage(): void {
  console.log(`Usage: email-mcp notify <subcommand>

Subcommands:
  test     Send a test desktop notification
  status   Check platform notification support
`);
}

async function runStatus(): Promise<void> {
  intro('email-mcp notify status');

  const spinner = p_spinner();
  spinner.start('Checking platform notification support…');

  const diag = await NotifierService.checkPlatformSupport();

  spinner.stop(`Platform: ${diag.platform}`);

  log.step('Desktop notifications');
  log.message(
    `  Tool: ${diag.desktopTool.name} — ${diag.desktopTool.available ? '✓ available' : '✗ not found'}`,
  );

  log.step('Sound alerts');
  log.message(
    `  Tool: ${diag.soundTool.name} — ${diag.soundTool.available ? '✓ available' : '✗ not found'}`,
  );

  if (diag.issues.length > 0) {
    log.warn('Issues detected:');
    diag.issues.forEach((issue) => log.message(`  ⚠ ${issue}`));
  }

  if (diag.setupInstructions.length > 0) {
    log.info('Setup instructions:');
    diag.setupInstructions.forEach((instruction) => log.message(`  ${instruction}`));
  }

  outro(diag.supported ? 'Notifications supported ✅' : 'Notifications not fully supported ❌');
}

async function runTest(): Promise<void> {
  ensureInteractive();
  intro('email-mcp notify test');

  const soundChoice = await select({
    message: 'Include sound with the test notification?',
    options: [
      { value: 'no', label: 'No sound', hint: 'silent desktop notification' },
      { value: 'yes', label: 'With sound', hint: 'plays an alert tone' },
    ],
    initialValue: 'no',
  });

  if (isCancel(soundChoice)) {
    outro('Cancelled.');
    return;
  }

  const withSound = soundChoice === 'yes';

  const spinner = p_spinner();
  spinner.start('Checking platform support…');

  const diag = await NotifierService.checkPlatformSupport();

  if (!diag.supported) {
    spinner.stop('Platform check failed');
    log.error(`Desktop notifications are not supported: ${diag.issues.join('; ')}`);
    if (diag.setupInstructions.length > 0) {
      log.info('Setup instructions:');
      diag.setupInstructions.forEach((instruction) => log.message(`  ${instruction}`));
    }
    outro('Fix the issues above and try again ❌');
    return;
  }

  spinner.stop(`Platform: ${diag.platform} — supported ✓`);

  // Create a temporary notifier with all channels enabled for the test
  const notifier = new NotifierService({
    desktop: true,
    sound: withSound,
    urgencyThreshold: 'low',
    webhookUrl: '',
    webhookEvents: [],
  });

  const sendSpinner = p_spinner();
  sendSpinner.start('Sending test notification…');

  try {
    const result = await notifier.sendTestNotification(withSound);
    notifier.stop();

    if (result.success) {
      sendSpinner.stop('Notification sent ✓');
      log.success(result.message);

      const visible = await confirm({
        message: 'Did you see the notification?',
        initialValue: true,
      });

      if (isCancel(visible)) {
        outro('Done.');
        return;
      }

      if (visible) {
        outro('Notifications are working ✅');
      } else {
        log.warn('The notification was sent but you did not see it.');
        log.info('Troubleshooting tips:');
        diag.setupInstructions.forEach((instruction) => log.message(`  ${instruction}`));
        outro('Check your notification settings and try again ⚠️');
      }
    } else {
      sendSpinner.stop('Notification failed');
      log.error(result.message);
      if (diag.setupInstructions.length > 0) {
        log.info('Setup instructions:');
        diag.setupInstructions.forEach((instruction) => log.message(`  ${instruction}`));
      }
      outro('Fix the issues above and try again ❌');
    }
  } catch (err) {
    notifier.stop();
    sendSpinner.stop('Notification failed');
    log.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    outro('Failed ❌');
  }
}

export default async function runNotifyCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case 'test':
      await runTest();
      break;

    case 'status':
      await runStatus();
      break;

    case undefined:
    case 'help':
    case '--help':
      printNotifyUsage();
      break;

    default:
      console.error(`Unknown notify subcommand: ${subcommand}\n`);
      printNotifyUsage();
      throw new Error(`Unknown notify subcommand: ${subcommand}`);
  }
}
