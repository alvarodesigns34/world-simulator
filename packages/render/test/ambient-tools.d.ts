/**
 * The WGSL validator is a plain .mjs tool so that Node can run it in CI without
 * a build step. This declares the shape the contract test consumes.
 */
declare module '*/tools/wgsl-validate.mjs' {
  export interface ReflectedMember {
    name: string;
    offset: number;
    size: number;
    type: string;
  }
  export interface ReflectedStruct {
    name: string;
    size: number;
    align: number;
    members: ReflectedMember[];
  }
  export interface ReflectedBinding {
    name: string;
    group: number;
    binding: number;
    typeName: string;
  }
  export interface ReflectedVertexInput {
    name: string;
    location: number | null;
    type: string;
    builtin: string | null;
  }
  export interface Reflected {
    structs: ReflectedStruct[];
    uniforms: ReflectedBinding[];
    storage: ReflectedBinding[];
    vertexEntries: { name: string; inputs: ReflectedVertexInput[] }[];
    fragmentEntries: { name: string }[];
    computeEntries: { name: string }[];
  }
  export function reflect(wgsl: string): Reflected;
  export function validateSource(label: string, wgsl: string): string[];
  export function validateAll(): { problems: string[]; reflected: Record<string, Reflected> };
  export function identifiers(wgsl: string): string[];
  export function extractTemplates(src: string): string[];
}
