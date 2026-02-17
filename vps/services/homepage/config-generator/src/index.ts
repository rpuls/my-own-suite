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
        // Strip surrounding quotes that might be added
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

/**
 * Process a single service entry
 * Homepage services format: { ServiceName: { href, description, icon, ... } }
 * Returns the service with placeholders replaced, or null if should be removed
 */
function processService(service: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, unknown> | null {
    // Replace placeholders
    const replaced = replacePlaceholdersInObject(service, env);

    // Check if any placeholders remain unresolved
    if (hasAnyUnresolvedPlaceholders(replaced)) {
        return null;
    }

    return replaced as Record<string, unknown>;
}

/**
 * Process a category
 * Homepage category format: { CategoryName: [Service1, Service2, ...] }
 * Returns the category with processed services, or null if category should be removed
 */
function processCategory(category: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, unknown> | null {
    const [categoryName, servicesArr] = Object.entries(category)[0];

    if (!Array.isArray(servicesArr)) {
        return category; // Keep as-is if not expected format
    }

    const processedServices: Record<string, unknown>[] = [];

    for (const service of servicesArr) {
        if (typeof service === 'object' && service !== null) {
            const processed = processService(service as Record<string, unknown>, env);
            if (processed !== null) {
                processedServices.push(processed);
            }
        }
    }

    // Remove category if all services were removed
    if (processedServices.length === 0) {
        return null;
    }

    return { [categoryName]: processedServices };
}

/**
 * Process the entire template
 */
function processTemplate(template: unknown[], env: Record<string, string | undefined>): unknown[] {
    const result: unknown[] = [];

    for (const category of template) {
        if (typeof category === 'object' && category !== null && !Array.isArray(category)) {
            const processed = processCategory(category as Record<string, unknown>, env);
            if (processed !== null) {
                result.push(processed);
            }
        }
    }

    return result;
}

/**
 * Count services in template (for logging)
 */
function countServices(template: unknown[]): { total: number; withPlaceholders: number } {
    let total = 0;
    let withPlaceholders = 0;

    for (const category of template) {
        if (typeof category !== 'object' || category === null || Array.isArray(category)) continue;

        const servicesArr = Object.values(category)[0];
        if (!Array.isArray(servicesArr)) continue;

        for (const service of servicesArr) {
            total++;
            if (hasAnyUnresolvedPlaceholders(service)) {
                withPlaceholders++;
            }
        }
    }

    return { total, withPlaceholders };
}

/**
 * Count services in output (for logging)
 */
function countOutputServices(output: unknown[]): number {
    let count = 0;
    for (const category of output) {
        if (typeof category === 'object' && category !== null && !Array.isArray(category)) {
            const servicesArr = Object.values(category)[0];
            if (Array.isArray(servicesArr)) {
                count += servicesArr.length;
            }
        }
    }
    return count;
}

/**
 * Main function
 */
function main(): void {
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
main();