/**
 * Homepage Template Replacer
 *
 * Reads a YAML template and replaces ${ENV_VAR} placeholders with values.
 * Removes services with unresolved placeholders and empty categories.
 *
 * Usage: node dist/index.js [config-dir]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse, stringify } from 'yaml';

/**
 * Default config directory (inside Docker container)
 */
const DEFAULT_CONFIG_DIR = '/app/config';

/**
 * Template and output file names
 */
const TEMPLATE_FILE = 'services.template.yaml';
const OUTPUT_FILE = 'services.yaml';
const CONFIG_FILES = new Set([
    'bookmarks.yaml',
    'widgets.yaml',
    'settings.yaml',
    'custom.css',
    'custom.js',
    'docker.yaml',
    'kubernetes.yaml',
    'services.template.yaml'
]);

/**
 * Regex to match ${VAR_NAME} placeholders
 */
const PLACEHOLDER_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Check if a string contains any unresolved placeholders
 */
function hasUnresolvedPlaceholders(value: string): boolean {
    PLACEHOLDER_REGEX.lastIndex = 0;
    return PLACEHOLDER_REGEX.test(value);
}

/**
 * Replace all ${VAR_NAME} placeholders in a string with env values
 */
function replacePlaceholders(value: string, env: Record<string, string | undefined>): string {
    return value.replace(PLACEHOLDER_REGEX, (match, varName) => {
        const envValue = env[varName];
        if (envValue === undefined || envValue === '') {
            return match; // Keep placeholder if not resolved
        }
        // Strip surrounding quotes that Railway might add
        return envValue.replace(/^["']|["']$/g, '');
    });
}

/**
 * Check if an object has any unresolved placeholders in any string value
 */
function hasAnyUnresolvedPlaceholders(obj: unknown): boolean {
    if (typeof obj === 'string') {
        return hasUnresolvedPlaceholders(obj);
    }

    if (Array.isArray(obj)) {
        return obj.some(item => hasAnyUnresolvedPlaceholders(item));
    }

    if (typeof obj === 'object' && obj !== null) {
        return Object.values(obj).some(val => hasAnyUnresolvedPlaceholders(val));
    }

    return false;
}

/**
 * Replace placeholders in an entire object recursively
 */
function replacePlaceholdersInObject(obj: unknown, env: Record<string, string | undefined>): unknown {
    if (typeof obj === 'string') {
        return replacePlaceholders(obj, env);
    }

    if (Array.isArray(obj)) {
        return obj.map(item => replacePlaceholdersInObject(item, env));
    }

    if (typeof obj === 'object' && obj !== null) {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(obj)) {
            result[key] = replacePlaceholdersInObject(val, env);
        }
        return result;
    }

    return obj;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively process one tree entry.
 * Rules:
 * - Leaf tile is removed if one or more placeholders are unresolved.
 * - Group/category/column is removed if all children are removed.
 */
function processEntry(entry: unknown, env: Record<string, string | undefined>): unknown | null {
    if (!isObjectRecord(entry)) {
        const replaced = replacePlaceholdersInObject(entry, env);
        return hasAnyUnresolvedPlaceholders(replaced) ? null : replaced;
    }

    const pairs = Object.entries(entry);
    if (pairs.length !== 1) {
        const replaced = replacePlaceholdersInObject(entry, env);
        return hasAnyUnresolvedPlaceholders(replaced) ? null : replaced;
    }

    const [name, value] = pairs[0];

    // Group-like node (column/category/etc)
    if (Array.isArray(value)) {
        const children: unknown[] = [];
        for (const child of value) {
            const processed = processEntry(child, env);
            if (processed !== null) {
                children.push(processed);
            }
        }

        // Remove group if all children were removed
        if (children.length === 0) {
            return null;
        }

        return { [name]: children };
    }

    // Leaf tile node
    const replacedLeaf = replacePlaceholdersInObject(entry, env);
    return hasAnyUnresolvedPlaceholders(replacedLeaf) ? null : replacedLeaf;
}

function processTemplate(template: unknown[], env: Record<string, string | undefined>): unknown[] {
    const result: unknown[] = [];
    for (const entry of template) {
        const processed = processEntry(entry, env);
        if (processed !== null) {
            result.push(processed);
        }
    }
    return result;
}

type ConfigExportFile = {
    name: string;
    content: string;
};

function isConfigExportFile(value: unknown): value is ConfigExportFile {
    if (!isObjectRecord(value)) {
        return false;
    }

    return typeof value.name === 'string' && typeof value.content === 'string' && CONFIG_FILES.has(value.name);
}

async function fetchRuntimeConfig(configUrl: string, configDir: string): Promise<void> {
    const token = process.env.HOMEPAGE_CONFIG_SYNC_TOKEN || '';
    if (!token) {
        throw new Error('HOMEPAGE_CONFIG_SYNC_TOKEN is required to fetch runtime config.');
    }

    const response = await fetch(configUrl, {
        headers: {
            authorization: `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error(`Config fetch failed with HTTP ${response.status}.`);
    }

    const body = await response.json() as { files?: unknown };
    if (!Array.isArray(body.files)) {
        throw new Error('Config fetch response did not include a files array.');
    }

    fs.mkdirSync(configDir, { recursive: true });

    let written = 0;
    for (const file of body.files) {
        if (!isConfigExportFile(file)) {
            continue;
        }

        fs.writeFileSync(path.join(configDir, file.name), file.content);
        written += 1;
    }

    console.log(`Fetched ${written} runtime config file(s) from Suite Manager.`);
}

/**
 * Count services in template (for logging)
 */
function countServices(template: unknown[]): { total: number; withPlaceholders: number } {
    function walk(node: unknown): { total: number; withPlaceholders: number } {
        if (!isObjectRecord(node)) {
            return { total: 0, withPlaceholders: 0 };
        }

        const pairs = Object.entries(node);
        if (pairs.length !== 1) {
            return { total: 0, withPlaceholders: 0 };
        }

        const [, value] = pairs[0];
        if (Array.isArray(value)) {
            return value.reduce<{ total: number; withPlaceholders: number }>(
                (acc, child) => {
                    const childCounts = walk(child);
                    acc.total += childCounts.total;
                    acc.withPlaceholders += childCounts.withPlaceholders;
                    return acc;
                },
                { total: 0, withPlaceholders: 0 }
            );
        }

        return {
            total: 1,
            withPlaceholders: hasAnyUnresolvedPlaceholders(node) ? 1 : 0
        };
    }

    return template.reduce<{ total: number; withPlaceholders: number }>(
        (acc, entry) => {
            const counts = walk(entry);
            acc.total += counts.total;
            acc.withPlaceholders += counts.withPlaceholders;
            return acc;
        },
        { total: 0, withPlaceholders: 0 }
    );
}

/**
 * Count services in output (for logging)
 */
function countOutputServices(output: unknown[]): number {
    function walk(node: unknown): number {
        if (!isObjectRecord(node)) {
            return 0;
        }

        const pairs = Object.entries(node);
        if (pairs.length !== 1) {
            return 0;
        }

        const [, value] = pairs[0];
        if (Array.isArray(value)) {
            return value.reduce((sum, child) => sum + walk(child), 0);
        }

        return 1;
    }

    return output.reduce<number>((sum, entry) => sum + walk(entry), 0);
}

/**
 * Main function
 */
async function main(): Promise<void> {
    if (process.argv[2] === '--fetch-config') {
        const configUrl = process.argv[3];
        const configDir = process.argv[4] || DEFAULT_CONFIG_DIR;
        if (!configUrl) {
            throw new Error('Usage: node dist/index.js --fetch-config <url> [config-dir]');
        }
        await fetchRuntimeConfig(configUrl, configDir);
        return;
    }

    // Determine config directory
    const configDir = process.argv[2] || DEFAULT_CONFIG_DIR;
    const env: Record<string, string | undefined> = process.env;

    console.log('Template Replacer starting...');
    console.log(`Config directory: ${configDir}`);

    // Read template
    const templatePath = path.join(configDir, TEMPLATE_FILE);
    if (!fs.existsSync(templatePath)) {
        console.log(`Template not found: ${templatePath}`);
        console.log('Skipping services.yaml generation.');
        return;
    }

    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const template = parse(templateContent);

    // Ensure template is an array
    const templateArray = Array.isArray(template) ? template : [template];

    // Count services
    const counts = countServices(templateArray);
    console.log(`Template contains ${counts.total} service(s), ${counts.withPlaceholders} with placeholders`);

    // Process template
    const processed = processTemplate(templateArray, env);

    // Count final services
    const finalCount = countOutputServices(processed);
    console.log(`Generated ${finalCount} service(s)`);

    // Write output
    const outputPath = path.join(configDir, OUTPUT_FILE);
    const outputContent = stringify(processed, {
        lineWidth: 0,
        indent: 4
    });

    fs.writeFileSync(outputPath, outputContent);
    console.log(`Generated: ${outputPath}`);

    // Summary
    if (finalCount === 0) {
        console.log('\nWarning: No services in output. Set environment variables to enable services.');
    }

    console.log('\nTemplate processing complete!');
}

// Run main function
main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Template processing failed.');
    process.exit(1);
});
