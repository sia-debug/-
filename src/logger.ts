import chalk from 'chalk';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

export const logger = {
  info(msg: string): void {
    console.log(`${chalk.gray(timestamp())} ${chalk.cyan('[INFO]')}    ${msg}`);
  },

  success(msg: string): void {
    console.log(`${chalk.gray(timestamp())} ${chalk.green('[SUCCESS]')} ${msg}`);
  },

  warn(msg: string): void {
    console.warn(`${chalk.gray(timestamp())} ${chalk.yellow('[WARN]')}    ${msg}`);
  },

  error(msg: string, err?: unknown): void {
    console.error(`${chalk.gray(timestamp())} ${chalk.red('[ERROR]')}   ${msg}`);
    if (err instanceof Error) {
      console.error(chalk.red(`  ${err.message}`));
      if (err.stack) console.error(chalk.gray(err.stack));
    } else if (err !== undefined) {
      console.error(err);
    }
  },

  row(rowIndex: number, name: string, msg: string): void {
    console.log(
      `${chalk.gray(timestamp())} ${chalk.blue(`[ROW ${rowIndex}]`)}  ${chalk.bold(name)} — ${msg}`
    );
  },
};
