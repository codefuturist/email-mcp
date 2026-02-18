import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TemplateService from './template.service.js';

const VALID_TEMPLATE = `name = "greeting"
description = "A greeting template"
subject = "Hello {{name}}"
body = "Dear {{name}}, welcome to {{company}}!"
variables = ["name", "company"]
`;

const MINIMAL_TEMPLATE = `name = "minimal"
subject = "Subject"
body = "Body"
variables = []
`;

describe('substituteVariables', () => {
  let tempDir: string;
  let service: TemplateService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmpl-sub-'));
    service = new TemplateService(tempDir);
    await fs.writeFile(path.join(tempDir, 'greeting.toml'), VALID_TEMPLATE);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true });
  });

  it('substitutes {{variable}} correctly', async () => {
    const result = await service.applyTemplate('greeting', { name: 'Alice', company: 'Acme' });
    expect(result.subject).toBe('Hello Alice');
    expect(result.body).toBe('Dear Alice, welcome to Acme!');
  });

  it('leaves unresolved {{unknown}} as-is', async () => {
    const tmpl = `name = "unknown"
subject = "Hi {{unknown}}"
body = "{{missing}} content"
variables = ["unknown", "missing"]
`;
    await fs.writeFile(path.join(tempDir, 'unknown.toml'), tmpl);
    const result = await service.applyTemplate('unknown', { unknown: 'val' });
    expect(result.subject).toBe('Hi val');
    expect(result.body).toBe('{{missing}} content');
  });

  it('handles empty variables map (all placeholders left as-is)', async () => {
    const result = await service.applyTemplate('greeting', {});
    expect(result.subject).toBe('Hello {{name}}');
    expect(result.body).toBe('Dear {{name}}, welcome to {{company}}!');
  });

  it('handles adjacent variables ({{a}}{{b}})', async () => {
    const tmpl = `name = "adjacent"
subject = "{{a}}{{b}}"
body = "{{a}}{{b}}{{a}}"
variables = ["a", "b"]
`;
    await fs.writeFile(path.join(tempDir, 'adjacent.toml'), tmpl);
    const result = await service.applyTemplate('adjacent', { a: 'X', b: 'Y' });
    expect(result.subject).toBe('XY');
    expect(result.body).toBe('XYX');
  });

  it('handles same variable used multiple times', async () => {
    const result = await service.applyTemplate('greeting', { name: 'Bob', company: 'Co' });
    expect(result.subject).toBe('Hello Bob');
    expect(result.body).toBe('Dear Bob, welcome to Co!');
  });
});

describe('TemplateService', () => {
  let tempDir: string;
  let service: TemplateService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmpl-svc-'));
    service = new TemplateService(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true });
  });

  it('listTemplates() returns empty array when directory is empty', async () => {
    const templates = await service.listTemplates();
    expect(templates).toEqual([]);
  });

  it('listTemplates() returns templates from .toml files', async () => {
    await fs.writeFile(path.join(tempDir, 'greeting.toml'), VALID_TEMPLATE);
    await fs.writeFile(path.join(tempDir, 'minimal.toml'), MINIMAL_TEMPLATE);

    const templates = await service.listTemplates();
    expect(templates).toHaveLength(2);
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(['greeting', 'minimal']);
  });

  it('listTemplates() skips invalid template files', async () => {
    await fs.writeFile(path.join(tempDir, 'good.toml'), VALID_TEMPLATE);
    await fs.writeFile(path.join(tempDir, 'bad.toml'), 'not valid toml [[[');
    await fs.writeFile(path.join(tempDir, 'missing-fields.toml'), 'name = "oops"\n');
    await fs.writeFile(path.join(tempDir, 'readme.txt'), 'ignored');

    const templates = await service.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('greeting');
  });

  it('listTemplates() returns empty array when directory does not exist', async () => {
    const noDir = path.join(tempDir, 'nonexistent');
    const svc = new TemplateService(noDir);
    const templates = await svc.listTemplates();
    expect(templates).toEqual([]);
  });

  it('getTemplate() returns a specific template by name', async () => {
    await fs.writeFile(path.join(tempDir, 'greeting.toml'), VALID_TEMPLATE);
    await fs.writeFile(path.join(tempDir, 'minimal.toml'), MINIMAL_TEMPLATE);

    const template = await service.getTemplate('minimal');
    expect(template.name).toBe('minimal');
    expect(template.subject).toBe('Subject');
    expect(template.body).toBe('Body');
    expect(template.variables).toEqual([]);
  });

  it('getTemplate() throws when template not found', async () => {
    await fs.writeFile(path.join(tempDir, 'greeting.toml'), VALID_TEMPLATE);

    await expect(service.getTemplate('nope')).rejects.toThrow(
      'Template "nope" not found. Available: greeting',
    );
  });

  it('applyTemplate() substitutes variables in subject and body', async () => {
    await fs.writeFile(path.join(tempDir, 'greeting.toml'), VALID_TEMPLATE);

    const result = await service.applyTemplate('greeting', { name: 'Alice', company: 'Acme' });
    expect(result.subject).toBe('Hello Alice');
    expect(result.body).toBe('Dear Alice, welcome to Acme!');
  });

  it('applyTemplate() leaves missing variables as placeholders', async () => {
    await fs.writeFile(path.join(tempDir, 'greeting.toml'), VALID_TEMPLATE);

    const result = await service.applyTemplate('greeting', { name: 'Alice' });
    expect(result.subject).toBe('Hello Alice');
    expect(result.body).toBe('Dear Alice, welcome to {{company}}!');
  });
});
