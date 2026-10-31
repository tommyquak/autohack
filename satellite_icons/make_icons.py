#!/usr/bin/env python3
"""Write five OBJ icons. Standard library only; dimensions are in build().

Satellite assemblies use overlapping, individually closed solid parts.
Output contains only v and f records. Quads count as two triangles.
Each .colors.json stores one RGB colour per OBJ face, in file order.
"""
import itertools
import json
import math
from pathlib import Path
import sys


class Mesh:
    def __init__(self):
        self.vertices, self.faces = [], []
        self.colors = []
        self.color = 'silver'

    def add(self, vertices, faces):
        offset = len(self.vertices)
        self.vertices.extend(vertices)
        self.faces.extend(tuple(offset + i for i in f) for f in faces)
        self.colors.extend([self.color] * len(faces))

    def bevel_box(self, x0, x1, y0, y1, z0, z1, bevel):
        centre = [(x0+x1)/2, (y0+y1)/2, (z0+z1)/2]
        half = [(x1-x0)/2, (y1-y0)/2, (z1-z0)/2]
        assert 0 < bevel < min(half)
        vertices, keys = [], []
        for signs in itertools.product((-1,1), repeat=3):
            for axis in range(3):
                keys.append((signs, axis))
                vertices.append(tuple(signs[k]*(half[k]-(0 if k==axis else bevel))
                                      for k in range(3)))
        faces = []
        def face(indices, normal):
            c = [sum(vertices[i][k] for i in indices)/len(indices) for k in range(3)]
            u = [vertices[indices[0]][k]-c[k] for k in range(3)]
            v = [normal[1]*u[2]-normal[2]*u[1],
                 normal[2]*u[0]-normal[0]*u[2],
                 normal[0]*u[1]-normal[1]*u[0]]
            # Normalize both in-plane axes before sorting.
            u = [x/math.sqrt(sum(t*t for t in u)) for x in u]
            v = [x/math.sqrt(sum(t*t for t in v)) for x in v]
            def angle(i):
                d = [vertices[i][k]-c[k] for k in range(3)]
                return math.atan2(sum(d[k]*v[k] for k in range(3)),
                                  sum(d[k]*u[k] for k in range(3)))
            faces.append(tuple(sorted(indices, key=angle)))
        for axis in range(3):
            for sign in (-1,1):
                face([i for i,(s,a) in enumerate(keys) if a==axis and s[axis]==sign],
                     [sign if k==axis else 0 for k in range(3)])
        for a,b in itertools.combinations(range(3),2):
            for sa,sb in itertools.product((-1,1),repeat=2):
                face([i for i,(s,axis) in enumerate(keys)
                      if axis in (a,b) and s[a]==sa and s[b]==sb],
                     [sa if k==a else sb if k==b else 0 for k in range(3)])
        for signs in itertools.product((-1,1),repeat=3):
            face([i for i,(s,a) in enumerate(keys) if s==signs], signs)
        self.add([tuple(v[k]+centre[k] for k in range(3)) for v in vertices], faces)

    def wing(self, x0, x1, half_y):
        self.color = 'silver'
        self.bevel_box(x0,x1,-half_y,half_y,-.024,.024,.009)
        # Two broad blue cell sections; visible on both sides of the panel.
        self.color = 'blue'
        for left,right in ((x0+.015,(x0+x1)/2-.006),
                           ((x0+x1)/2+.006,x1-.015)):
            self.box(left,right,-half_y+.012,half_y-.012,-.026,.026)

    def box(self, x0, x1, y0, y1, z0, z1):
        self.add([(x0,y0,z0), (x1,y0,z0), (x1,y1,z0), (x0,y1,z0),
                  (x0,y0,z1), (x1,y0,z1), (x1,y1,z1), (x0,y1,z1)],
                 [(0,3,2,1), (4,5,6,7), (0,1,5,4),
                  (1,2,6,5), (2,3,7,6), (3,0,4,7)])

    def lathe(self, rings, sides=8, cx=0, cy=0):
        # Rings run bottom to top: (z, radius). Equal z makes a shoulder.
        vertices = [(cx + r*math.cos(2*math.pi*i/sides),
                     cy + r*math.sin(2*math.pi*i/sides), z)
                    for z, r in rings for i in range(sides)]
        faces = []
        for k in range(len(rings)-1):
            for i in range(sides):
                j = (i+1) % sides
                faces.append((k*sides+i, k*sides+j,
                              (k+1)*sides+j, (k+1)*sides+i))
        bottom, top = len(vertices), len(vertices)+1
        vertices += [(cx,cy,rings[0][0]), (cx,cy,rings[-1][0])]
        last = (len(rings)-1)*sides
        for i in range(sides):
            j = (i+1) % sides
            faces += [(bottom,j,i), (top,last+i,last+j)]
        self.add(vertices, faces)

    def write(self, path):
        # Centre the bounding box without changing dimensions.
        lo = [min(v[a] for v in self.vertices) for a in range(3)]
        hi = [max(v[a] for v in self.vertices) for a in range(3)]
        centre = [(lo[a]+hi[a])/2 for a in range(3)]
        vertices = [tuple(round(v[a]-centre[a], 6) for a in range(3))
                    for v in self.vertices]
        triangles = sum(len(f)-2 for f in self.faces)
        assert triangles <= 300, (path.name, triangles)
        assert all(abs(c) <= 0.5 for v in vertices for c in v)
        # Each undirected edge must occur twice, in opposite directions.
        edges = {}
        for face in self.faces:
            assert len(face) in (3,4)
            for a, b in zip(face, face[1:]+face[:1]):
                edges.setdefault(tuple(sorted((a,b))), []).append((a,b))
        assert all(len(e) == 2 and e[0] == e[1][::-1]
                   for e in edges.values()), path.name
        lines = ['v ' + ' '.join(f'{c:.6f}' for c in v) for v in vertices]
        lines += ['f ' + ' '.join(str(i+1) for i in f) for f in self.faces]
        path.write_text('\n'.join(lines)+'\n', encoding='ascii')
        palette = {'gold':[237,177,62], 'blue':[49,116,220],
                   'silver':[174,191,207], 'teal':[48,193,171],
                   'orange':[231,118,65], 'purple':[167,117,232],
                   'graphite':[67,81,103]}
        path.with_suffix('.colors.json').write_text(json.dumps({
            'face_index_base':0, 'color_space':'sRGB',
            'palette_rgb':palette, 'face_colors':self.colors},indent=2)+'\n')
        print(f'{path.name}: {len(vertices)} vertices, '
              f'{len(self.faces)} faces, {triangles} triangles')


def build():
    models = {}

    own = models['own_satellite.obj'] = Mesh()
    own.color = 'gold'
    own.bevel_box(-.175,.175, -.175,.175, -.25,.25,.045)
    for side in (-1,1):
        own.color = 'graphite'
        a,b = sorted((side*.16, side*.255))
        own.box(a,b, -.035,.035, -.025,.025)  # short arm
        a,b = sorted((side*.23, side*.5))
        own.wing(a,b,.17)
    own.color = 'silver'
    own.lathe([(.24,.035), (.36,.035)], sides=6)  # antenna stub

    payload = models['payload.obj'] = Mesh()
    payload.color = 'teal'
    payload.lathe([(-.3,.15),(-.25,.2),(.25,.2),(.3,.15)], sides=6)
    payload.color = 'graphite'
    payload.box(.17,.29, -.035,.035, -.025,.025)
    payload.wing(.26,.66,.19)

    rocket = models['rocket_body.obj'] = Mesh()
    rocket.lathe([(-.5,.14),(-.46,.14),(-.32,.065),(-.28,.065),
                  (-.28,.12),(-.23,.15),(.33,.15),(.40,.15),
                  (.45,.15),(.5,.11)], sides=10)
    for index,f in enumerate(rocket.faces):
        z = sum(rocket.vertices[i][2] for i in f)/len(f)
        rocket.colors[index] = 'graphite' if z < -.28 else 'orange' if .33 < z < .40 else 'silver'

    debris = models['debris.obj'] = Mesh()
    debris.color = 'orange'
    # A thin folded metal sheet, with four long torn points.
    # Outline is CCW and star-shaped about (0,0); z defines each fold.
    outline = [(.34,0,.065), (.09,.055,.025), (.13,.29,.12),
               (-.035,.10,-.035), (-.29,.12,.07), (-.10,-.015,-.06),
               (-.18,-.28,-.10), (.035,-.10,.015)]
    n, thickness = len(outline), .018
    vertices = [(x,y,z-thickness/2) for x,y,z in outline]
    vertices += [(x,y,z+thickness/2) for x,y,z in outline]
    vertices += [(0,0,-thickness/2), (0,0,thickness/2)]
    faces = []
    for i in range(n):
        j = (i+1) % n
        faces += [(2*n,j,i), (2*n+1,n+i,n+j), (i,j,n+j,n+i)]
    debris.add(vertices, faces)

    unknown = models['unknown.obj'] = Mesh()
    unknown.color = 'purple'
    unknown.add([(.5,0,0), (0,.5,0), (-.5,0,0), (0,-.5,0),
                 (0,0,.5), (0,0,-.5)],
                [(4,0,1), (4,1,2), (4,2,3), (4,3,0),
                 (5,1,0), (5,2,1), (5,3,2), (5,0,3)])
    return models


if __name__ == '__main__':
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('.')
    destination.mkdir(parents=True, exist_ok=True)
    for filename, mesh in build().items():
        mesh.write(destination / filename)
