/**
 * Template service — load, parse, and apply user-defined email templates.
 *
 * Templates are stored as TOML files in the XDG config templates directory.
 * Each template has a name, optional description, subject, body, and a list
 * of variable names used for {{variable}} substitution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseTOML } from 'smol-toml';

import { TEMPLATES_DIR } from '../config/xdg.js';
import { sanitizeTemplateVariable } from '../safety/validation.js';

import type { EmailTemplate } from '../types/index.js';

/**
 * Validate that a parsed object looks like an EmailTemplate.
 * Returns the template or throws with a descriptive message.
 */
function validateTemplate(raw: Record<string, unknown>, filename: string): EmailTemplate {
  const { name, description, subject, body, variables } = raw;

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Template "${filename}" is missing a valid "name" field`);
  }
  if (typeof subject !== 'string') {
    throw new Error(`Template "${filename}" is missing a "subject" field`);
  }
  if (typeof body !== 'string') {
    throw new Error(`Template "${filename}" is missing a "body" field`);
  }
  if (!Array.isArray(variables) || !variables.every((v) => typeof v === 'string')) {
    throw new Error(`Template "${filename}" must have a "variables" array of strings`);
  }

  return {
    name,
    description: typeof description === 'string' ? description : undefined,
    subject,
    body,
    variables,
  } as EmailTemplate;
}

/**
 * Replace all {{variable}} placeholders in a string with the provided values.
 */
function substituteVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
    if (varName in variables) {
      return variables[varName];
    }
    return match; // Leave unresolved placeholders as-is
  });
}

export default class TemplateService {
  private templatesDir: string;

  constructor(templatesDir = TEMPLATES_DIR) {
    this.templatesDir = templatesDir;
  }

  /**
   * List all templates from the templates directory.
   * Returns metadata only (name, description, variables).
   */
  async listTemplates(): Promise<EmailTemplate[]> {
    try {
      await fs.access(this.templatesDir);
    } catch {
      return []; // Directory doesn't exist yet — no templates
    }

    const entries = await fs.readdir(this.templatesDir);
    const tomlFiles = entries.filter((f) => f.endsWith('.toml'));
    const templates: EmailTemplate[] = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const file of tomlFiles) {
      try {
        const filePath = path.join(this.templatesDir, file);
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.readFile(filePath, 'utf-8');
        const raw = parseTOML(content) as Record<string, unknown>;
        templates.push(validateTemplate(raw, file));
      } catch {
        // Skip invalid templates silently
      }
    }

    return templates;
  }

  /**
   * Get a single template by name.
   */
  async getTemplate(name: string): Promise<EmailTemplate> {
    const templates = await this.listTemplates();
    const template = templates.find((t) => t.name === name);
    if (!template) {
      const available = templates.map((t) => t.name).join(', ') || 'none';
      throw new Error(`Template "${name}" not found. Available: ${available}`);
    }
    return template;
  }

  /**
   * Apply variable substitution to a template.
   * Returns the composed subject and body with variables replaced.
   * Missing variables are left as {{variable}} placeholders.
   */
  async applyTemplate(
    name: string,
    variables: Record<string, string>,
    html = false,
  ): Promise<{ subject: string; body: string }> {
    const template = await this.getTemplate(name);
    const sanitized = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [k, sanitizeTemplateVariable(v, html)]),
    );

    // Warn about missing variables
    const missing = template.variables.filter((v) => !(v in sanitized));
    if (missing.length > 0) {
      const composed = {
        subject: substituteVariables(template.subject, sanitized),
        body: substituteVariables(template.body, sanitized),
      };
      return composed;
    }

    return {
      subject: substituteVariables(template.subject, sanitized),
      body: substituteVariables(template.body, sanitized),
    };
  }

  /** Get the templates directory path. */
  get directory(): string {
    return this.templatesDir;
  }
}
