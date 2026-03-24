// Cornell Box Path Tracer with Temporal Accumulation
(function() {
  const canvas = document.getElementById('cornell-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) {
    console.warn('WebGL not supported');
    return;
  }
  console.log('WebGL context:', gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1');

  // Cornell box dimensions
  let WIDTH = 800;
  let HEIGHT = 600;
  const SAMPLES_PER_FRAME = 2;
  const MAX_BOUNCES = 5;

  // Camera
  let cameraPos = [0, 5, 15];
  let cameraTarget = [0, 2.5, 0];
  let cameraAngleX = 0;
  let cameraAngleY = 0;

  // Mouse control
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  // Accumulation
  let sampleCount = 0;
  let accumulatedColor = null;
  let needsReset = true;

  // Vertex shader
  const vertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Fragment shader - Path Tracer
  const fragmentShaderSource = `
    precision highp float;
    varying vec2 v_uv;

    uniform vec2 u_resolution;
    uniform vec3 u_cameraPos;
    uniform vec3 u_cameraTarget;
    uniform float u_time;
    uniform int u_sampleIndex;
    uniform int u_maxBounces;
    uniform sampler2D u_accumulation;

    #define PI 3.14159265359
    #define EPSILON 0.0001
    #define LIGHT_SAMPLES 4

    // Random
    float seed;
    float random() {
      seed = fract(sin(seed) * 43758.5453123);
      return seed;
    }

    vec3 randomInUnitSphere() {
      float u = random();
      float v = random();
      float theta = u * 2.0 * PI;
      float phi = acos(2.0 * v - 1.0);
      float r = pow(random(), 0.3333);
      float sinTheta = sin(theta);
      float cosTheta = cos(theta);
      float sinPhi = sin(phi);
      float cosPhi = cos(phi);
      float x = r * sinPhi * cosTheta;
      float y = r * sinPhi * sinTheta;
      float z = r * cosPhi;
      return vec3(x, y, z);
    }

    vec3 randomCosineDirection() {
      float u = random();
      float v = random();
      float r = sqrt(u);
      float theta = 2.0 * PI * v;
      float x = r * cos(theta);
      float y = r * sin(theta);
      float z = sqrt(1.0 - u);
      return vec3(x, y, z);
    }

    // Materials
    const int MAT_LAMBERTIAN = 0;
    const int MAT_LIGHT = 1;

    struct Material {
      int type;
      vec3 albedo;
      vec3 emission;
    };

    // Ray
    struct Ray {
      vec3 origin;
      vec3 direction;
    };

    // Hit record
    struct Hit {
      float t;
      vec3 point;
      vec3 normal;
      Material material;
      bool hit;
    };

    // Box intersection
    bool boxIntersect(vec3 ro, vec3 rd, vec3 boxMin, vec3 boxMax, out float tNear, out float tFar) {
      vec3 invDir = 1.0 / rd;
      vec3 t0 = (boxMin - ro) * invDir;
      vec3 t1 = (boxMax - ro) * invDir;
      vec3 tmin = min(t0, t1);
      vec3 tmax = max(t0, t1);
      tNear = max(max(tmin.x, tmin.y), tmin.z);
      tFar = min(min(tmax.x, tmax.y), tmax.z);
      return tNear < tFar && tFar > 0.0;
    }

    // Scene - Cornell Box
    // 0: floor/ceiling/walls
    // 1: left wall (red)
    // 2: right wall (green)
    // 3: tall box
    // 4: small box
    // 5: light

    Hit intersectScene(Ray ray) {
      Hit hit;
      hit.hit = false;
      hit.t = 1e30;

      float t;
      vec3 normal;
      int materialId;

      // Floor (y = 0)
      if (abs(ray.direction.y) > EPSILON) {
        t = -ray.origin.y / ray.direction.y;
        if (t > EPSILON && t < hit.t) {
          vec3 p = ray.origin + t * ray.direction;
          if (p.x >= -5.0 && p.x <= 5.0 && p.z >= -5.0 && p.z <= 5.0) {
            hit.t = t;
            hit.point = p;
            hit.normal = vec3(0, 1, 0);
            hit.material.type = MAT_LAMBERTIAN;
            hit.material.albedo = vec3(0.95, 0.95, 0.95);
            hit.material.emission = vec3(0);
            hit.hit = true;
          }
        }
      }

      // Ceiling (y = 5)
      if (abs(ray.direction.y) > EPSILON) {
        t = (5.0 - ray.origin.y) / ray.direction.y;
        if (t > EPSILON && t < hit.t) {
          vec3 p = ray.origin + t * ray.direction;
          if (p.x >= -5.0 && p.x <= 5.0 && p.z >= -5.0 && p.z <= 5.0) {
            hit.t = t;
            hit.point = p;
            hit.normal = vec3(0, -1, 0);
            hit.material.type = MAT_LAMBERTIAN;
            hit.material.albedo = vec3(0.95, 0.95, 0.95);
            hit.material.emission = vec3(0);
            hit.hit = true;
          }
        }
      }

      // Back wall (z = -5)
      if (abs(ray.direction.z) > EPSILON) {
        t = (-5.0 - ray.origin.z) / ray.direction.z;
        if (t > EPSILON && t < hit.t) {
          vec3 p = ray.origin + t * ray.direction;
          if (p.x >= -5.0 && p.x <= 5.0 && p.y >= 0.0 && p.y <= 5.0) {
            hit.t = t;
            hit.point = p;
            hit.normal = vec3(0, 0, 1);
            hit.material.type = MAT_LAMBERTIAN;
            hit.material.albedo = vec3(0.95, 0.95, 0.95);
            hit.material.emission = vec3(0);
            hit.hit = true;
          }
        }
      }

      // Left wall (x = -5) - RED
      if (abs(ray.direction.x) > EPSILON) {
        t = (-5.0 - ray.origin.x) / ray.direction.x;
        if (t > EPSILON && t < hit.t) {
          vec3 p = ray.origin + t * ray.direction;
          if (p.y >= 0.0 && p.y <= 5.0 && p.z >= -5.0 && p.z <= 5.0) {
            hit.t = t;
            hit.point = p;
            hit.normal = vec3(1, 0, 0);
            hit.material.type = MAT_LAMBERTIAN;
            hit.material.albedo = vec3(0.63, 0.065, 0.05);
            hit.material.emission = vec3(0);
            hit.hit = true;
          }
        }
      }

      // Right wall (x = 5) - GREEN
      if (abs(ray.direction.x) > EPSILON) {
        t = (5.0 - ray.origin.x) / ray.direction.x;
        if (t > EPSILON && t < hit.t) {
          vec3 p = ray.origin + t * ray.direction;
          if (p.y >= 0.0 && p.y <= 5.0 && p.z >= -5.0 && p.z <= 5.0) {
            hit.t = t;
            hit.point = p;
            hit.normal = vec3(-1, 0, 0);
            hit.material.type = MAT_LAMBERTIAN;
            hit.material.albedo = vec3(0.14, 0.45, 0.091);
            hit.material.emission = vec3(0);
            hit.hit = true;
          }
        }
      }

      // Tall box (center-left)
      float tNear, tFar;
      vec3 boxMin = vec3(-2.5, 0, -2.5);
      vec3 boxMax = vec3(-1.5, 4, 0.5);
      if (boxIntersect(ray.origin, ray.direction, boxMin, boxMax, tNear, tFar)) {
        if (tNear > EPSILON && tNear < hit.t) {
          hit.t = tNear;
          hit.point = ray.origin + tNear * ray.direction;
          vec3 center = (boxMin + boxMax) * 0.5;
          vec3 d = hit.point - center;
          vec3 absd = abs(d);
          if (absd.x > absd.y && absd.x > absd.z) {
            hit.normal = vec3(sign(d.x), 0, 0);
          } else if (absd.y > absd.z) {
            hit.normal = vec3(0, sign(d.y), 0);
          } else {
            hit.normal = vec3(0, 0, sign(d.z));
          }
          hit.material.type = MAT_LAMBERTIAN;
          hit.material.albedo = vec3(0.95, 0.95, 0.95);
          hit.material.emission = vec3(0);
          hit.hit = true;
        }
      }

      // Small box (front-right)
      boxMin = vec3(1, 0, 2);
      boxMax = vec3(2.2, 1.5, 3.2);
      if (boxIntersect(ray.origin, ray.direction, boxMin, boxMax, tNear, tFar)) {
        if (tNear > EPSILON && tNear < hit.t) {
          hit.t = tNear;
          hit.point = ray.origin + tNear * ray.direction;
          vec3 center = (boxMin + boxMax) * 0.5;
          vec3 d = hit.point - center;
          vec3 absd = abs(d);
          if (absd.x > absd.y && absd.x > absd.z) {
            hit.normal = vec3(sign(d.x), 0, 0);
          } else if (absd.y > absd.z) {
            hit.normal = vec3(0, sign(d.y), 0);
          } else {
            hit.normal = vec3(0, 0, sign(d.z));
          }
          hit.material.type = MAT_LAMBERTIAN;
          hit.material.albedo = vec3(0.95, 0.95, 0.95);
          hit.material.emission = vec3(0);
          hit.hit = true;
        }
      }

      // Light (ceiling area light)
      if (abs(ray.direction.y) > EPSILON) {
        t = (5.0 - ray.origin.y) / ray.direction.y;
        if (t > EPSILON && t <= hit.t) {
          vec3 p = ray.origin + t * ray.direction;
          if (p.x >= -2.0 && p.x <= 2.0 && p.z >= -2.0 && p.z <= 2.0) {
            hit.t = t;
            hit.point = p;
            hit.normal = vec3(0, -1, 0);
            hit.material.type = MAT_LIGHT;
            hit.material.albedo = vec3(1, 1, 1);
            hit.material.emission = vec3(15);
            hit.hit = true;
          }
        }
      }

      return hit;
    }

    vec3 skyColor(Ray ray) {
      return vec3(0);
    }

    vec3 trace(Ray ray) {
      Hit hit = intersectScene(ray);

      if (!hit.hit) {
        return vec3(0);
      }

      return hit.normal * 0.5 + 0.5;
    }

    mat3 setCamera(vec3 ro, vec3 ta) {
      vec3 cw = normalize(ta - ro);
      vec3 up = vec3(0, 1, 0);
      vec3 cu = normalize(cross(cw, up));
      vec3 cv = normalize(cross(cu, cw));
      return mat3(cu, cv, cw);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

      mat3 cam = setCamera(u_cameraPos, u_cameraTarget);
      vec3 rd = cam * normalize(vec3(uv, 1.5));

      Ray ray;
      ray.origin = u_cameraPos;
      ray.direction = rd;

      vec3 col = trace(ray);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // Compile shader
  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    console.error('Shader compilation failed');
    return;
  }
  const program = createProgram(gl, vertexShader, fragmentShader);
  if (!program) {
    console.error('Program creation failed');
    return;
  }
  console.log('Shader compiled successfully');

  // Attributes and uniforms
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
  const cameraPosLocation = gl.getUniformLocation(program, 'u_cameraPos');
  const cameraTargetLocation = gl.getUniformLocation(program, 'u_cameraTarget');
  const timeLocation = gl.getUniformLocation(program, 'u_time');
  const sampleIndexLocation = gl.getUniformLocation(program, 'u_sampleIndex');
  const maxBouncesLocation = gl.getUniformLocation(program, 'u_maxBounces');

  // Create fullscreen quad
  const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  // Resize canvas
  function resize() {
    const container = canvas.parentElement;
    if (!container || container.clientWidth === 0) {
      console.log('Cornell: container not ready, retrying...');
      requestAnimationFrame(resize);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    WIDTH = Math.floor(container.clientWidth * dpr) || 800;
    HEIGHT = Math.floor(container.clientHeight * dpr) || 600;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = (container.clientWidth || 800) + 'px';
    canvas.style.height = (container.clientHeight || 600) + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
    console.log('Cornell: initialized', WIDTH, 'x', HEIGHT);
    needsReset = true;
    sampleCount = 0;
  }
  resize();
  window.addEventListener('resize', resize);

  // Mouse events
  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    needsReset = true;
    sampleCount = 0;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    cameraAngleY += dx * 0.005;
    cameraAngleX += dy * 0.005;
    cameraAngleX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cameraAngleX));
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    needsReset = true;
    sampleCount = 0;
  });

  canvas.addEventListener('mouseup', () => {
    isDragging = false;
  });

  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
  });

  // Touch events
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      lastMouseX = e.touches[0].clientX;
      lastMouseY = e.touches[0].clientY;
      needsReset = true;
      sampleCount = 0;
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - lastMouseX;
    const dy = e.touches[0].clientY - lastMouseY;
    cameraAngleY += dx * 0.005;
    cameraAngleX += dy * 0.005;
    cameraAngleX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cameraAngleX));
    lastMouseX = e.touches[0].clientX;
    lastMouseY = e.touches[0].clientY;
    needsReset = true;
    sampleCount = 0;
  });

  canvas.addEventListener('touchend', () => {
    isDragging = false;
  });

  // Animation
  let startTime = performance.now();
  let frameCount = 0;

  function render() {
    const time = (performance.now() - startTime) / 1000;

    // Update camera position based on angles
    const radius = 15;
    cameraPos[0] = Math.sin(cameraAngleY) * Math.cos(cameraAngleX) * radius;
    cameraPos[1] = Math.sin(cameraAngleX) * radius + 2.5;
    cameraPos[2] = Math.cos(cameraAngleY) * Math.cos(cameraAngleX) * radius;

    gl.useProgram(program);

    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform3f(cameraPosLocation, cameraPos[0], cameraPos[1], cameraPos[2]);
    gl.uniform3f(cameraTargetLocation, cameraTarget[0], cameraTarget[1], cameraTarget[2]);
    gl.uniform1f(timeLocation, time);
    gl.uniform1i(sampleIndexLocation, sampleCount);
    gl.uniform1i(maxBouncesLocation, MAX_BOUNCES);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    sampleCount++;
    frameCount++;

    requestAnimationFrame(render);
  }

  render();
})();
