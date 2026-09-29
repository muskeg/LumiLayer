import { strToU8, zip, zipSync, type Zippable } from 'fflate';
import type { Mesh } from './mesh';

export interface Part {
  name: string;
  color: string;
  extruder: number;
  mesh: Mesh;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Accumulates XML text and encodes it in chunks to avoid giant strings. */
class XmlWriter {
  private parts: string[] = [];
  private size = 0;
  private chunks: Uint8Array[] = [];
  private enc = new TextEncoder();

  push(s: string) {
    this.parts.push(s);
    this.size += s.length;
    if (this.size > 1 << 20) this.flush();
  }

  private flush() {
    if (!this.parts.length) return;
    this.chunks.push(this.enc.encode(this.parts.join('')));
    this.parts = [];
    this.size = 0;
  }

  bytes(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

export function buildModelXml(parts: Part[], title = 'LumiLayer lithophane') {
  const w = new XmlWriter();
  const assemblyId = parts.length + 2;
  w.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      ' <metadata name="Application">LumiLayer</metadata>\n <resources>\n  <basematerials id="1">\n',
  );
  for (const p of parts)
    w.push(`   <base name="${escapeXml(p.name)}" displaycolor="${p.color.toUpperCase()}"/>\n`);
  w.push('  </basematerials>\n');
  parts.forEach((p, idx) => {
    w.push(`  <object id="${idx + 2}" type="model" name="${escapeXml(p.name)}" pid="1" pindex="${idx}">\n   <mesh>\n    <vertices>\n`);
    const pos = p.mesh.positions;
    for (let i = 0; i < pos.length; i += 3)
      w.push(`<vertex x="${pos[i].toFixed(3)}" y="${pos[i + 1].toFixed(3)}" z="${pos[i + 2].toFixed(3)}"/>\n`);
    w.push('    </vertices>\n    <triangles>\n');
    const ind = p.mesh.indices;
    for (let i = 0; i < ind.length; i += 3)
      w.push(`<triangle v1="${ind[i]}" v2="${ind[i + 1]}" v3="${ind[i + 2]}"/>\n`);
    w.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  w.push(`  <object id="${assemblyId}" type="model" name="${escapeXml(title)}">\n   <components>\n`);
  parts.forEach((_, idx) => w.push(`    <component objectid="${idx + 2}"/>\n`));
  w.push(`   </components>\n  </object>\n </resources>\n <build>\n  <item objectid="${assemblyId}"/>\n </build>\n</model>\n`);

  // Bambu Studio / Orca part metadata: names and extruder (AMS slot) per part.
  let cfg = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="${assemblyId}">\n  <metadata key="name" value="${escapeXml(title)}"/>\n  <metadata key="extruder" value="1"/>\n`;
  parts.forEach((p, idx) => {
    cfg += `  <part id="${idx + 2}" subtype="normal_part">\n   <metadata key="name" value="${escapeXml(p.name)}"/>\n   <metadata key="extruder" value="${p.extruder}"/>\n  </part>\n`;
  });
  cfg += ' </object>\n</config>\n';

  return { model: w.bytes(), config: strToU8(cfg) };
}

function packageFiles(parts: Part[], title?: string): Zippable {
  const { model, config } = buildModelXml(parts, title);
  return {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': model,
    'Metadata/model_settings.config': config,
  };
}

export function write3mf(parts: Part[], title?: string): Promise<Uint8Array> {
  const files = packageFiles(parts, title);
  return new Promise((resolve, reject) =>
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))),
  );
}

/** Synchronous variant for use inside a Web Worker (no nested workers). */
export function write3mfSync(parts: Part[], title?: string): Uint8Array {
  return zipSync(packageFiles(parts, title), { level: 6 });
}
