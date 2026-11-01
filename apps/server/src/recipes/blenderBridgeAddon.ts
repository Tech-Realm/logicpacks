/**
 * The Blender bridge add-on (Python). Kept as a string so the bundled server
 * can write it into each session: Blender cannot read files inside app.asar.
 */
export const BLENDER_BRIDGE_ADDON_PATH = "blender/logicpacks_bridge.py";

export const BLENDER_BRIDGE_ADDON = String.raw`"""LogicPacks bridge for Blender.

Part of the LogicPacks Blender recipe (apps/server/src/recipes). It does two things inside a
running Blender:

1. Opens a local socket (127.0.0.1, JSON lines) so agents can read and change
   the scene through the recipe's MCP tools.
2. Records every change to the scene as semantic ops on stable object ids
   (custom property "lp_id") in "<session>/oplog.jsonl". Changes made by
   agents and changes made by hand in the viewport land in the same log, because
   both are found the same way: by diffing tracked properties against the
   state the log already describes.

Run it either as an add-on (Edit > Preferences > Add-ons > Install) or from the
command line, which is how the recipe launcher starts it:

    blender scene.blend --python logicpacks_bridge.py -- --session DIR [--port N]
    blender -b scene.blend --python logicpacks_bridge.py -- --session DIR --serve

"--serve" keeps a background ("-b") Blender alive and serving until a
"quit" command arrives. The chosen port and a random token are written to
"<session>/bridge.json" (owner-only). Every request must carry that token, so
other local users and web pages cannot drive the scene.
"""

bl_info = {
    "name": "LogicPacks bridge",
    "author": "LogicPacks",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "Runs in the background",
    "description": "Lets LogicPacks agents work in this scene and records every edit as a mergeable op log.",
    "category": "System",
}

import base64
import hmac
import json
import math
import os
import queue
import secrets
import shutil
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

import bpy
from mathutils import Vector

ID_PROP = "lp_id"
PRIMITIVE_PROP = "lp_primitive"
FLOAT_DIGITS = 5
SYNC_INTERVAL_SECONDS = 0.5

PRIMITIVES = {
    "cube": ("MESH", lambda: bpy.ops.mesh.primitive_cube_add()),
    "plane": ("MESH", lambda: bpy.ops.mesh.primitive_plane_add()),
    "uv_sphere": ("MESH", lambda: bpy.ops.mesh.primitive_uv_sphere_add()),
    "ico_sphere": ("MESH", lambda: bpy.ops.mesh.primitive_ico_sphere_add()),
    "cylinder": ("MESH", lambda: bpy.ops.mesh.primitive_cylinder_add()),
    "cone": ("MESH", lambda: bpy.ops.mesh.primitive_cone_add()),
    "torus": ("MESH", lambda: bpy.ops.mesh.primitive_torus_add()),
    "monkey": ("MESH", lambda: bpy.ops.mesh.primitive_monkey_add()),
    "empty": ("EMPTY", None),
    "camera": ("CAMERA", None),
    "point_light": ("LIGHT", "POINT"),
    "sun_light": ("LIGHT", "SUN"),
    "spot_light": ("LIGHT", "SPOT"),
    "area_light": ("LIGHT", "AREA"),
}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _round(value):
    if isinstance(value, float):
        rounded = round(value, FLOAT_DIGITS)
        return 0.0 if rounded == 0 else rounded
    if isinstance(value, (list, tuple)):
        return [_round(item) for item in value]
    return value


def _values_equal(left, right):
    if isinstance(left, (int, float)) and isinstance(right, (int, float)) and not isinstance(left, bool):
        return math.isclose(left, right, abs_tol=1e-4)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_values_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        keys = set(left) | set(right)
        return all(_values_equal(left.get(key), right.get(key)) for key in keys)
    return left == right


# ---------------------------------------------------------------------------
# Reading and writing tracked properties
# ---------------------------------------------------------------------------


def _object_props(obj):
    parent = obj.parent.get(ID_PROP) if obj.parent is not None else None
    props = {
        "name": obj.name,
        "location": _round(list(obj.location)),
        "rotation_euler": _round(list(obj.rotation_euler)),
        "scale": _round(list(obj.scale)),
        "hide_viewport": bool(obj.hide_viewport),
        "hide_render": bool(obj.hide_render),
        "parent": parent,
    }
    primitive = obj.get(PRIMITIVE_PROP)
    if primitive is not None:
        props["primitive"] = str(primitive)
    if obj.type == "LIGHT" and obj.data is not None:
        props["light.type"] = obj.data.type
        props["light.energy"] = _round(float(obj.data.energy))
        props["light.color"] = _round(list(obj.data.color))
    if obj.type == "CAMERA" and obj.data is not None:
        props["camera.lens"] = _round(float(obj.data.lens))
    return props


def _find_by_id(object_id):
    for obj in bpy.data.objects:
        if obj.get(ID_PROP) == object_id:
            return obj
    return None


def _set_prop(obj, prop, value):
    if prop == "name":
        obj.name = str(value)
    elif prop in ("location", "rotation_euler", "scale"):
        setattr(obj, prop, [float(item) for item in value])
    elif prop in ("hide_viewport", "hide_render"):
        setattr(obj, prop, bool(value))
    elif prop == "parent":
        obj.parent = _find_by_id(value) if value else None
    elif prop == "primitive":
        obj[PRIMITIVE_PROP] = str(value)
    elif prop == "light.energy" and obj.type == "LIGHT":
        obj.data.energy = float(value)
    elif prop == "light.color" and obj.type == "LIGHT":
        obj.data.color = [float(item) for item in value]
    elif prop == "camera.lens" and obj.type == "CAMERA":
        obj.data.lens = float(value)
    elif prop == "light.type":
        pass  # fixed at creation
    else:
        raise ValueError(f"Property {prop!r} is not one the bridge tracks.")


def _create_object(primitive, name=None):
    if primitive not in PRIMITIVES:
        raise ValueError(f"Unknown primitive {primitive!r}. Known: {', '.join(sorted(PRIMITIVES))}.")
    kind, extra = PRIMITIVES[primitive]
    collection = bpy.context.scene.collection
    if kind == "MESH":
        before = set(bpy.data.objects)
        extra()
        created = [obj for obj in bpy.data.objects if obj not in before]
        obj = created[0]
    elif kind == "EMPTY":
        obj = bpy.data.objects.new(name or "Empty", None)
        collection.objects.link(obj)
    elif kind == "CAMERA":
        data = bpy.data.cameras.new(name or "Camera")
        obj = bpy.data.objects.new(name or "Camera", data)
        collection.objects.link(obj)
    else:
        data = bpy.data.lights.new(name or "Light", type=extra)
        obj = bpy.data.objects.new(name or "Light", data)
        collection.objects.link(obj)
    obj[PRIMITIVE_PROP] = primitive
    if name:
        obj.name = name
    return obj


def _delete_object(obj):
    bpy.data.objects.remove(obj, do_unlink=True)


# ---------------------------------------------------------------------------
# The live view LogicPacks shows in place of the file editor
# ---------------------------------------------------------------------------


class _ViewRenderSettings:
    """Render settings for one quick frame, put back exactly as they were afterwards."""

    def __init__(self, width, height):
        self.size = (width, height)

    def __enter__(self):
        scene = bpy.context.scene
        render = scene.render
        self.saved = (
            render.engine,
            render.resolution_x,
            render.resolution_y,
            render.resolution_percentage,
            render.filepath,
            render.image_settings.file_format,
            scene.camera,
        )
        render.resolution_x, render.resolution_y = self.size
        render.resolution_percentage = 100
        render.image_settings.file_format = "PNG"
        return render

    def __exit__(self, *exc):
        scene = bpy.context.scene
        render = scene.render
        (
            render.engine,
            render.resolution_x,
            render.resolution_y,
            render.resolution_percentage,
            render.filepath,
            render.image_settings.file_format,
            scene.camera,
        ) = self.saved
        return False


def _viewport_view(path, width):
    """With a window: draw the 3D viewport offscreen, from the person's own angle and shading.

    An offscreen draw rather than a screenshot, because a window in the background
    stops redrawing and its last frame goes stale. None when there is no viewport.
    """
    if bpy.app.background:
        return None
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next((r for r in area.regions if r.type == "WINDOW"), None)
            if region is None or region.width < 2 or region.height < 2:
                continue
            height = max(90, round(width * region.height / region.width))
            with bpy.context.temp_override(window=window, screen=window.screen, area=area, region=region):
                with _ViewRenderSettings(width, height):
                    bpy.ops.render.opengl(view_context=True)
            bpy.data.images["Render Result"].save_render(filepath=path)
            return "viewport"
    return None


def _frame_camera(camera):
    """Point a temporary camera at everything in the scene, from the usual 3/4 angle."""
    points = [
        obj.matrix_world @ Vector(corner)
        for obj in bpy.context.scene.objects
        if obj.type not in ("CAMERA", "LIGHT") and obj is not camera
        for corner in obj.bound_box
    ]
    if not points:
        points = [Vector((0.0, 0.0, 0.0))]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (low + high) / 2
    radius = max((high - low).length / 2, 1.0)
    direction = Vector((1.0, -1.2, 0.8)).normalized()
    camera.location = center + direction * radius * 4.2
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()


def _render_view(path, width):
    """Headless: a quick Workbench render, from the scene camera or a temporary one."""
    scene = bpy.context.scene
    camera = None
    try:
        with _ViewRenderSettings(width, max(90, width * 9 // 16)) as render:
            if scene.camera is None:
                camera = bpy.data.objects.new("lp_view", bpy.data.cameras.new("lp_view"))
                scene.collection.objects.link(camera)
                _frame_camera(camera)
                scene.camera = camera
            render.engine = "BLENDER_WORKBENCH"
            render.filepath = path
            bpy.ops.render.render(write_still=True)
    finally:
        if camera is not None:
            data = camera.data
            bpy.data.objects.remove(camera, do_unlink=True)
            bpy.data.cameras.remove(data)
    return "render"

# ---------------------------------------------------------------------------
# The op log
# ---------------------------------------------------------------------------


class OpLog:
    def __init__(self, session_dir):
        self.session_dir = session_dir
        self.path = os.path.join(session_dir, "oplog.jsonl")
        self.ops = []
        self.known = {}  # object id -> {"type": str, "props": dict}
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        op = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # a torn last line must not hide the rest
                    self.ops.append(op)
                    self._replay(op)

    def _replay(self, op):
        kind = op.get("kind")
        object_id = op.get("objectId")
        if kind == "object.add":
            self.known[object_id] = {"type": op.get("objectType"), "props": dict(op.get("value") or {})}
        elif kind == "object.set" and object_id in self.known:
            self.known[object_id]["props"][op.get("property")] = op.get("value")
        elif kind == "object.remove":
            self.known.pop(object_id, None)

    def append(self, actor, kind, object_id, **fields):
        op = {
            "id": uuid.uuid4().hex,
            "seq": (self.ops[-1]["seq"] + 1) if self.ops else 1,
            "at": _now(),
            "actor": actor,
            "kind": kind,
            "objectId": object_id,
        }
        op.update({key: value for key, value in fields.items() if value is not None or key == "value"})
        self.ops.append(op)
        self._replay(op)
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(op) + "\n")
        return op

    def sync(self, actor):
        """Diff the scene against what the log describes and record the difference."""
        recorded = []
        seen = set()
        for obj in list(bpy.data.objects):
            object_id = obj.get(ID_PROP)
            if not object_id or object_id in seen:
                # New, or a duplicate that copied its original's id.
                object_id = uuid.uuid4().hex[:12]
                obj[ID_PROP] = object_id
            seen.add(object_id)
            props = _object_props(obj)
            known = self.known.get(object_id)
            if known is None:
                recorded.append(
                    self.append(actor, "object.add", object_id, name=obj.name, objectType=obj.type, value=props)
                )
                continue
            before = known["props"]
            for prop, value in props.items():
                if not _values_equal(before.get(prop), value):
                    recorded.append(
                        self.append(
                            actor,
                            "object.set",
                            object_id,
                            name=obj.name,
                            property=prop,
                            value=value,
                            previous=before.get(prop),
                        )
                    )
        for object_id in [key for key in self.known if key not in seen]:
            name = self.known[object_id]["props"].get("name")
            recorded.append(self.append(actor, "object.remove", object_id, name=name))
        return recorded


# ---------------------------------------------------------------------------
# Commands, run on Blender's main thread
# ---------------------------------------------------------------------------


class Bridge:
    def __init__(self, session_dir, human_actor):
        os.makedirs(session_dir, exist_ok=True)
        self.session_dir = session_dir
        self.human = human_actor
        self.log = OpLog(session_dir)
        self.requests = queue.Queue()
        self.stopping = False
        self.server = None
        self.port = None
        self.connections = 0
        self.token = secrets.token_hex(16)

    # -- helpers --------------------------------------------------------------

    def _object(self, args):
        if args.get("id"):
            obj = _find_by_id(args["id"])
        elif args.get("name"):
            obj = bpy.data.objects.get(args["name"])
        else:
            raise ValueError("Pass the object's id (preferred) or name.")
        if obj is None:
            raise ValueError(f"No object with {'id ' + args['id'] if args.get('id') else 'name ' + args['name']}.")
        return obj

    def _describe(self, obj):
        return {"id": obj.get(ID_PROP), "type": obj.type, **_object_props(obj)}

    # -- commands -------------------------------------------------------------

    def cmd_status(self, args, actor):
        return {
            "file": bpy.data.filepath or None,
            "session": self.session_dir,
            "ops": len(self.log.ops),
            "objects": len(bpy.data.objects),
            "blender": bpy.app.version_string,
            "background": bool(bpy.app.background),
        }

    def cmd_list_scene(self, args, actor):
        self.log.sync(self.human)  # anything done by hand since the last look
        return {"objects": [self._describe(obj) for obj in bpy.data.objects]}

    def cmd_add_object(self, args, actor):
        self.log.sync(self.human)
        obj = _create_object(args.get("primitive", "cube"), args.get("name"))
        for prop in ("location", "rotation_euler", "scale"):
            if args.get(prop) is not None:
                _set_prop(obj, prop, args[prop])
        ops = self.log.sync(actor)
        return {"object": self._describe(obj), "ops": len(ops)}

    def cmd_modify_object(self, args, actor):
        self.log.sync(self.human)
        obj = self._object(args)
        for prop, value in (args.get("props") or {}).items():
            _set_prop(obj, prop, value)
        ops = self.log.sync(actor)
        return {"object": self._describe(obj), "ops": len(ops)}

    def cmd_delete_object(self, args, actor):
        self.log.sync(self.human)
        obj = self._object(args)
        object_id = obj.get(ID_PROP)
        _delete_object(obj)
        ops = self.log.sync(actor)
        return {"removed": object_id, "ops": len(ops)}

    def cmd_run_op(self, args, actor):
        self.log.sync(self.human)
        path = str(args.get("operator", ""))
        module_name, _, op_name = path.partition(".")
        module = getattr(bpy.ops, module_name, None)
        operator = getattr(module, op_name, None) if module is not None else None
        if operator is None:
            raise ValueError(f"No operator bpy.ops.{path}.")
        result = operator(**(args.get("kwargs") or {}))
        ops = self.log.sync(actor)
        return {"result": sorted(result), "ops": len(ops)}

    def cmd_snapshot(self, args, actor):
        self.log.sync(self.human)
        name = "".join(ch for ch in str(args.get("name") or "snapshot") if ch.isalnum() or ch in "-_") or "snapshot"
        target = os.path.join(self.session_dir, "snapshots", name)
        os.makedirs(target, exist_ok=True)
        blend = os.path.join(target, "scene.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend, copy=True)
        log_copy = os.path.join(target, "oplog.jsonl")
        if os.path.exists(self.log.path):
            shutil.copyfile(self.log.path, log_copy)
        else:
            open(log_copy, "w").close()
        return {"dir": target, "blend": blend, "ops": len(self.log.ops)}

    def cmd_export_oplog(self, args, actor):
        self.log.sync(self.human)
        return {"ops": self.log.ops}

    def cmd_apply_ops(self, args, actor):
        """Apply drafts from a merge. Each lands in the log under its own actor."""
        self.log.sync(self.human)
        applied = 0
        skipped = []
        for draft in args.get("drafts") or []:
            kind = draft.get("kind")
            object_id = draft.get("objectId")
            draft_actor = draft.get("actor") or actor
            try:
                if kind == "object.add":
                    props = dict(draft.get("value") or {})
                    primitive = props.get("primitive") or _primitive_for_type(draft.get("objectType"), props)
                    obj = _create_object(primitive, props.get("name"))
                    obj[ID_PROP] = object_id
                    for prop, value in props.items():
                        if prop not in ("primitive", "light.type"):
                            _set_prop(obj, prop, value)
                elif kind == "object.set":
                    obj = _find_by_id(object_id)
                    if obj is None:
                        raise ValueError("object is gone")
                    _set_prop(obj, draft.get("property"), draft.get("value"))
                elif kind == "object.remove":
                    obj = _find_by_id(object_id)
                    if obj is not None:
                        _delete_object(obj)
                else:
                    raise ValueError(f"unknown op kind {kind!r}")
                self.log.sync(draft_actor)
                applied += 1
            except Exception as error:  # report, keep going
                skipped.append({"objectId": object_id, "kind": kind, "reason": str(error)})
        return {"applied": applied, "skipped": skipped, "ops": len(self.log.ops)}

    def cmd_view(self, args, actor):
        """What LogicPacks shows for the project: the app's view and the scene outline.

        Each object carries who changed it last, from the op log, so people and
        agents show on the items they are working on.
        """
        self.log.sync(self.human)
        last = {}
        for op in self.log.ops:
            last[op.get("objectId")] = {"actor": op.get("actor"), "at": op.get("at"), "kind": op.get("kind")}
        objects = [
            {
                "id": obj.get(ID_PROP),
                "name": obj.name,
                "type": obj.type,
                "parent": obj.parent.get(ID_PROP) if obj.parent is not None else None,
                "hidden": bool(obj.hide_viewport),
                "last": last.get(obj.get(ID_PROP)),
            }
            for obj in bpy.data.objects
        ]
        result = {
            "file": bpy.data.filepath or None,
            "background": bool(bpy.app.background),
            "ops": len(self.log.ops),
            "objects": objects,
            "image": None,
            "mode": None,
        }
        if args.get("image") is False:
            return result
        width = max(160, min(int(args.get("width") or 960), 1920))
        path = os.path.join(self.session_dir, "view.png")
        try:
            mode = None
            try:
                mode = _viewport_view(path, width)
            except Exception:
                mode = None  # no drawable viewport right now: render instead
            if mode is None:
                mode = _render_view(path, width)
            with open(path, "rb") as handle:
                result["image"] = base64.b64encode(handle.read()).decode("ascii")
            result["mode"] = mode
        except Exception as error:
            result["imageError"] = str(error)
        return result

    def cmd_render(self, args, actor):
        """Render one frame of the scene camera to a PNG under the session."""
        self.log.sync(self.human)
        width = max(160, min(int(args.get("width") or 960), 3840))
        name = "".join(ch for ch in str(args.get("name") or "render") if ch.isalnum() or ch in "-_") or "render"
        target_dir = os.path.join(self.session_dir, "renders")
        os.makedirs(target_dir, exist_ok=True)
        path = os.path.join(target_dir, f"{name}.png")
        scene = bpy.context.scene
        if args.get("frame") is not None:
            scene.frame_set(int(args["frame"]))
        engine = args.get("engine")
        mode = _render_view(path, width) if engine is None else None
        if engine is not None:
            with _ViewRenderSettings(width, max(90, width * 9 // 16)) as render:
                render.engine = str(engine)
                render.filepath = path
                bpy.ops.render.render(write_still=True)
            mode = "render"
        return {"path": path, "mode": mode, "frame": scene.frame_current}

    def cmd_list_snapshots(self, args, actor):
        base = os.path.join(self.session_dir, "snapshots")
        out = []
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                blend = os.path.join(base, name, "scene.blend")
                if os.path.exists(blend):
                    ops = 0
                    log_copy = os.path.join(base, name, "oplog.jsonl")
                    if os.path.exists(log_copy):
                        with open(log_copy, "r", encoding="utf-8") as handle:
                            ops = sum(1 for line in handle if line.strip())
                    out.append({"name": name, "blend": blend, "ops": ops, "at": os.path.getmtime(blend)})
        return {"snapshots": out}

    def cmd_restore(self, args, actor):
        """Put every tracked object back the way the snapshot had it.

        Works from the snapshot's op log, so it needs no file reload and every
        change it makes is itself logged (under the restoring actor) and can be
        undone the same way. Mesh geometry and materials are not restored.
        """
        self.log.sync(self.human)
        name = "".join(ch for ch in str(args.get("name") or "") if ch.isalnum() or ch in "-_")
        log_copy = os.path.join(self.session_dir, "snapshots", name, "oplog.jsonl")
        if not name or not os.path.exists(log_copy):
            raise ValueError(f"No snapshot called {name!r}.")
        target = {}
        with open(log_copy, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    op = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = op.get("kind")
                oid = op.get("objectId")
                if kind == "object.add":
                    target[oid] = {"type": op.get("objectType"), "props": dict(op.get("value") or {})}
                elif kind == "object.set" and oid in target:
                    target[oid]["props"][op.get("property")] = op.get("value")
                elif kind == "object.remove":
                    target.pop(oid, None)
        changed = 0
        for obj in list(bpy.data.objects):
            oid = obj.get(ID_PROP)
            if oid not in target:
                _delete_object(obj)
                changed += 1
        present = {obj.get(ID_PROP): obj for obj in bpy.data.objects}
        for oid, entry in target.items():
            props = entry["props"]
            obj = present.get(oid)
            if obj is None:
                primitive = props.get("primitive") or _primitive_for_type(entry["type"], props)
                obj = _create_object(primitive, props.get("name"))
                obj[ID_PROP] = oid
                changed += 1
            current = _object_props(obj)
            for prop, value in props.items():
                if prop in ("primitive", "light.type", "parent"):
                    continue
                if not _values_equal(current.get(prop), value):
                    _set_prop(obj, prop, value)
                    changed += 1
        for oid, entry in target.items():
            parent = entry["props"].get("parent")
            obj = _find_by_id(oid)
            if obj is not None and (obj.parent.get(ID_PROP) if obj.parent else None) != parent:
                _set_prop(obj, "parent", parent)
        ops = self.log.sync(actor)
        return {"restored": name, "changed": changed, "ops": len(ops)}

    def cmd_exec(self, args, actor):
        """Run Blender Python. Set "result" to return a value. Edits are logged like any other."""
        self.log.sync(self.human)
        code = str(args.get("code") or "")
        scope = {"bpy": bpy, "result": None}
        exec(compile(code, "<logicpacks>", "exec"), scope)
        ops = self.log.sync(actor)
        result = scope.get("result")
        try:
            json.dumps(result)
        except TypeError:
            result = repr(result)
        return {"result": result, "ops": len(ops)}

    def cmd_save(self, args, actor):
        path = args.get("path") or bpy.data.filepath
        if not path:
            raise ValueError("This scene has never been saved. Pass a path.")
        bpy.ops.wm.save_as_mainfile(filepath=path)
        return {"file": path}

    def cmd_quit(self, args, actor):
        self.stopping = True
        return {"stopping": True}

    # -- dispatch -------------------------------------------------------------

    def handle(self, request):
        cmd = request.get("cmd")
        actor = request.get("actor") or {"kind": "agent", "id": "agent"}
        handler = getattr(self, f"cmd_{cmd}", None)
        if handler is None:
            return {"id": request.get("id"), "ok": False, "error": f"Unknown command {cmd!r}."}
        try:
            return {"id": request.get("id"), "ok": True, "result": handler(request.get("args") or {}, actor)}
        except Exception as error:
            return {"id": request.get("id"), "ok": False, "error": str(error)}

    def drain(self):
        """Run queued requests. Must be called on the main thread."""
        while True:
            try:
                request, reply = self.requests.get_nowait()
            except queue.Empty:
                return
            reply["response"] = self.handle(request)
            reply["done"].set()

    # -- socket ---------------------------------------------------------------

    def start(self, port):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", port))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        info_path = os.path.join(self.session_dir, "bridge.json")
        descriptor = os.open(info_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                {"port": self.port, "pid": os.getpid(), "file": bpy.data.filepath or None, "token": self.token},
                handle,
            )
        os.chmod(info_path, 0o600)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while not self.stopping:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection):
        self.connections += 1
        buffer = b""
        try:
            with connection:
                while not self.stopping:
                    chunk = connection.recv(65536)
                    if not chunk:
                        return
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            request = json.loads(line)
                        except json.JSONDecodeError:
                            connection.sendall(json.dumps({"ok": False, "error": "Not JSON."}).encode() + b"\n")
                            continue
                        if not isinstance(request, dict) or not hmac.compare_digest(
                            str(request.get("token") or ""), self.token
                        ):
                            refusal = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": "Unauthorized: pass the token from bridge.json."}
                            connection.sendall(json.dumps(refusal).encode() + b"\n")
                            continue
                        reply = {"done": threading.Event()}
                        self.requests.put((request, reply))
                        reply["done"].wait()
                        connection.sendall(json.dumps(reply["response"]).encode() + b"\n")
        finally:
            self.connections -= 1

    def stop(self):
        self.stopping = True
        if self.server is not None:
            try:
                self.server.close()
            except OSError:
                pass


def _primitive_for_type(object_type, props):
    if object_type == "CAMERA":
        return "camera"
    if object_type == "EMPTY":
        return "empty"
    if object_type == "LIGHT":
        return f"{str(props.get('light.type', 'POINT')).lower()}_light"
    return "cube"


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

_bridge = None


def _timer():
    if _bridge is None:
        return None
    _bridge.drain()
    if not _bridge.requests.qsize():
        # Pick up edits made by hand in the viewport.
        try:
            _bridge.log.sync(_bridge.human)
        except Exception:
            pass
    return 0.05 if _bridge.requests.qsize() else SYNC_INTERVAL_SECONDS


def _parse_args(argv):
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    options = {
        "session": os.environ.get("LP_RECIPE_SESSION"),
        "port": int(os.environ.get("LP_RECIPE_PORT", "0")),
        "serve": False,
        "actor": os.environ.get("LP_RECIPE_ACTOR", "local"),
        "actor_name": os.environ.get("LP_RECIPE_ACTOR_NAME"),
    }
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--serve":
            options["serve"] = True
        elif arg in ("--session", "--port", "--actor", "--actor-name") and index + 1 < len(args):
            index += 1
            key = arg[2:].replace("-", "_")
            options[key] = int(args[index]) if key == "port" else args[index]
        index += 1
    if not options["session"]:
        base = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else os.getcwd()
        options["session"] = os.path.join(base, ".logicpacks", "blender")
    return options


def start(options):
    global _bridge
    human = {"kind": "human", "id": options["actor"]}
    if options.get("actor_name"):
        human["name"] = options["actor_name"]
    _bridge = Bridge(options["session"], human)
    _bridge.log.sync(human)  # whatever the file already holds becomes the base
    _bridge.start(options["port"])
    print(f"[logicpacks] bridge on 127.0.0.1:{_bridge.port}, session {options['session']}", flush=True)
    if options["serve"]:
        while not _bridge.stopping:
            _bridge.drain()
            time.sleep(0.01)
        _bridge.stop()
        print("[logicpacks] bridge stopped", flush=True)
    else:
        bpy.app.timers.register(_timer, first_interval=0.1, persistent=True)


def register():
    if _bridge is None:
        start(_parse_args([]))


def unregister():
    global _bridge
    if _bridge is not None:
        _bridge.stop()
        _bridge = None
    if bpy.app.timers.is_registered(_timer):
        bpy.app.timers.unregister(_timer)


if __name__ == "__main__":
    start(_parse_args(sys.argv))
`;
