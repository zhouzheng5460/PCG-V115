// 极简 glTF 2.0 / GLB 写出器。
// 不依赖 three 的 GLTFExporter（它要 FileReader / Blob，Node 端不方便），
// 自己拼 JSON + BIN 两个 chunk，浏览器和 Node 都能跑。

import type { Primitive } from './build3d';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UINT = 5125;

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

interface BufferViewDef {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface AccessorDef {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

export interface GlbResult {
  bytes: Uint8Array;
  triangles: number;
  meshes: number;
}

export function exportGLB(primitives: Primitive[], generator = 'townforge'): GlbResult {
  const valid = primitives.filter((p) => p && p.indices.length > 0 && p.positions.length > 0);

  // ---- 先算 BIN 布局
  const blobs: { data: ArrayBufferView; target: number }[] = [];
  let binLength = 0;
  const bufferViews: BufferViewDef[] = [];
  const accessors: AccessorDef[] = [];

  const pushView = (data: ArrayBufferView, target: number): number => {
    const padding = pad4(binLength);
    binLength += padding;
    const offset = binLength;
    binLength += data.byteLength;
    blobs.push({ data, target });
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    return bufferViews.length - 1;
  };

  const materials: unknown[] = [];
  const materialIndex = new Map<string, number>();
  const meshes: unknown[] = [];
  /**
   * 节点树：**按 `prim.path` 建目录**。
   *
   * 之前所有 mesh 都平铺在场景根下 —— 一座城 2000+ 个节点全是同级，
   * 进 Blender 只能看到一长串 `B12-T1-P3_house_0`，没法按"街道 / 街区 / 建筑"操作。
   * 现在按 `城市 / 街道 / 街区 / B12 / 建筑` 建组节点，mesh 挂在最深层。
   * 组节点只有 `children`，叶子节点只有 `mesh` —— 这是 glTF 允许的写法。
   */
  interface NodeDef {
    name: string;
    children?: number[];
    mesh?: number;
    extras?: Record<string, unknown>;
  }
  const nodes: NodeDef[] = [];
  const groupOf = new Map<string, number>();
  const ROOT = '城市';
  const ensurePath = (path: string[]): number => {
    let key = '';
    let parent = -1;
    for (const seg of [ROOT, ...path]) {
      key = key ? `${key}/${seg}` : seg;
      let idx = groupOf.get(key);
      if (idx === undefined) {
        idx = nodes.length;
        nodes.push({ name: seg, children: [] });
        groupOf.set(key, idx);
        if (parent >= 0) nodes[parent].children!.push(idx);
      }
      parent = idx;
    }
    return parent;
  };

  for (const prim of valid) {
    const pos = new Float32Array(prim.positions);
    const nrm = new Float32Array(prim.normals);
    const idx = new Uint32Array(prim.indices);

    // min/max
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], pos[i + k]);
        max[k] = Math.max(max[k], pos[i + k]);
      }
    }

    const posView = pushView(pos, ARRAY_BUFFER);
    const nrmView = pushView(nrm, ARRAY_BUFFER);
    const idxView = pushView(idx, ELEMENT_ARRAY_BUFFER);

    const posAcc = accessors.length;
    accessors.push({ bufferView: posView, byteOffset: 0, componentType: FLOAT, count: pos.length / 3, type: 'VEC3', min, max });
    const nrmAcc = accessors.length;
    accessors.push({ bufferView: nrmView, byteOffset: 0, componentType: FLOAT, count: nrm.length / 3, type: 'VEC3' });
    const idxAcc = accessors.length;
    accessors.push({ bufferView: idxView, byteOffset: 0, componentType: UINT, count: idx.length, type: 'SCALAR' });

    const colorKey = prim.color.map((c) => c.toFixed(4)).join(',');
    let mat = materialIndex.get(colorKey);
    if (mat === undefined) {
      mat = materials.length;
      materials.push({
        name: `${prim.group}_mat`,
        pbrMetallicRoughness: {
          baseColorFactor: [prim.color[0], prim.color[1], prim.color[2], 1],
          metallicFactor: 0,
          roughnessFactor: 0.92,
        },
        doubleSided: prim.doubleSided ?? false,
      });
      materialIndex.set(colorKey, mat);
    }

    meshes.push({
      name: prim.name,
      primitives: [
        { attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc, material: mat, mode: 4 },
      ],
    });

    const parent = ensurePath(prim.path ?? ['未分组']);
    const leaf = nodes.length;
    nodes.push({ mesh: meshes.length - 1, name: prim.name, extras: { group: prim.group, path: (prim.path ?? []).join('/') } });
    nodes[parent].children!.push(leaf);
  }

  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    // 场景根只挂"城市"这一个节点，其余全在它的子树里
    scenes: [{ nodes: [groupOf.get(ROOT)!] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: bufferViews.map((v) => ({ ...v })),
    buffers: [{ byteLength: binLength }],
  };

  // ---- 拼 BIN
  const bin = new Uint8Array(binLength);
  for (let i = 0; i < blobs.length; i++) {
    const view = bufferViews[i];
    bin.set(new Uint8Array(blobs[i].data.buffer, blobs[i].data.byteOffset, blobs[i].data.byteLength), view.byteOffset);
  }

  // ---- 拼 GLB
  let jsonText = JSON.stringify(gltf);
  const jsonPad = pad4(jsonText.length);
  jsonText += ' '.repeat(jsonPad);
  const jsonBytes = new TextEncoder().encode(jsonText);

  const binPad = pad4(binLength);
  const total = 12 + 8 + jsonBytes.length + 8 + binLength + binPad;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;

  dv.setUint32(o, GLB_MAGIC, true);
  dv.setUint32(o + 4, 2, true);
  dv.setUint32(o + 8, total, true);
  o += 12;

  dv.setUint32(o, jsonBytes.length, true);
  dv.setUint32(o + 4, CHUNK_JSON, true);
  o += 8;
  out.set(jsonBytes, o);
  o += jsonBytes.length;

  dv.setUint32(o, binLength + binPad, true);
  dv.setUint32(o + 4, CHUNK_BIN, true);
  o += 8;
  out.set(bin, o);

  let triangles = 0;
  for (const p of valid) triangles += p.indices.length / 3;

  return { bytes: out, triangles, meshes: valid.length };
}

/** 校验每个三角形的绕序与给定顶点法线一致（导出前自检用） */
export function checkWinding(prim: Primitive): number {
  let bad = 0;
  const { positions, normals, indices } = prim;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const dot = nx * normals[a] + ny * normals[a + 1] + nz * normals[a + 2];
    if (dot <= 0) bad++;
  }
  return bad;
}
