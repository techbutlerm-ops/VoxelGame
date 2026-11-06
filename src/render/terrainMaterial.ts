import * as THREE from 'three';

/**
 * Vertex-colored standard material for terrain and debris.
 * - Procedural, world-space detail: two octaves of value noise break up flat color the way a
 *   painted texture would, without any image assets.
 * - A per-vertex `light` attribute (sky exposure, glow): sun, moon and sky light fade with sky
 *   exposure so caves are dark, while lamps and the flashlight still light everything; lamp
 *   blocks glow.
 */
export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nattribute vec2 light;\nvarying vec2 vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = light;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
varying vec2 vLight;
float vhash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vhash(i + vec3(0,0,0)), vhash(i + vec3(1,0,0)), f.x),
                 mix(vhash(i + vec3(0,1,0)), vhash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(vhash(i + vec3(0,0,1)), vhash(i + vec3(1,0,1)), f.x),
                 mix(vhash(i + vec3(0,1,1)), vhash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  // Keep the noise lattice small-valued for precision far from the planet origin.
  vec3 p = mod(vWorldPos, 4096.0);
  float n = vnoise(p * 0.45) * 0.6 + vnoise(p * 1.7) * 0.4;
  float broad = vnoise(p * 0.035);
  diffuseColor.rgb *= 0.86 + 0.22 * n;
  diffuseColor.rgb *= 0.92 + 0.16 * broad;
}`,
      )
      // Sun and moon (directional) fade underground; shadows handle occlusion near the player.
      .replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= mix( 0.06, 1.0, vLight.x );',
      )
      // Sky light (hemisphere) fades underground.
      .replace(
        'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );',
        'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * mix( 0.03, 1.0, vLight.x );',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vLight.y * 2.2;',
      );
  };
  return mat;
}
