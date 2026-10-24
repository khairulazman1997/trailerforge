"""A tiny stand-in for the CLIP model with the same file names and inputs/outputs, built at test
time, so the ONNX and tokenizer plumbing runs for real without any download."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DIM = 8
WORDS = ["[UNK]", "a", "red", "blue", "boss", "forest", "parry", "screenshot"]


def _save(graph, path: Path) -> None:
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, str(path))


def build_combined(dir_: Path) -> Path:
    """One model taking text and image together, like the onnx-community CLIP exports."""
    dir_.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    w = numpy_helper.from_array(rng.normal(size=(3, DIM)).astype(np.float32), "W")
    table = numpy_helper.from_array(rng.normal(size=(len(WORDS), DIM)).astype(np.float32), "E")
    graph = helper.make_graph(
        [
            helper.make_node("ReduceMean", ["pixel_values"], ["m"], axes=[2, 3], keepdims=0),
            helper.make_node("MatMul", ["m", "W"], ["image_embeds"]),
            helper.make_node("Gather", ["E", "input_ids"], ["g"]),
            helper.make_node("ReduceMean", ["g"], ["text_embeds"], axes=[1], keepdims=0),
        ],
        "clip",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, None]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, None]),
            helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, 224, 224]),
        ],
        [
            helper.make_tensor_value_info("text_embeds", TensorProto.FLOAT, [1, DIM]),
            helper.make_tensor_value_info("image_embeds", TensorProto.FLOAT, [1, DIM]),
        ],
        [w, table],
    )
    _save(graph, dir_ / "model.onnx")
    _tokenizer(dir_)
    return dir_


def _tokenizer(dir_: Path) -> None:
    from tokenizers import Tokenizer, models, pre_tokenizers

    tok = Tokenizer(models.WordLevel({w: i for i, w in enumerate(WORDS)}, unk_token="[UNK]"))
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    tok.save(str(dir_ / "tokenizer.json"))


def build(dir_: Path, *, pooled: bool = True) -> Path:
    dir_.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    w = numpy_helper.from_array(rng.normal(size=(3, DIM)).astype(np.float32), "W")
    vision = helper.make_graph(
        [
            helper.make_node("ReduceMean", ["pixel_values"], ["m"], axes=[2, 3], keepdims=0),
            helper.make_node("MatMul", ["m", "W"], ["image_embeds"]),
        ],
        "vision",
        [helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, 224, 224])],
        [helper.make_tensor_value_info("image_embeds", TensorProto.FLOAT, [1, DIM])],
        [w],
    )
    _save(vision, dir_ / "vision.onnx")

    table = numpy_helper.from_array(rng.normal(size=(len(WORDS), DIM)).astype(np.float32), "E")
    nodes = [helper.make_node("Gather", ["E", "input_ids"], ["g"])]
    if pooled:
        nodes.append(helper.make_node("ReduceMean", ["g"], ["text_embeds"], axes=[1], keepdims=0))
        out_shape = [1, DIM]
    else:
        nodes.append(helper.make_node("Identity", ["g"], ["text_embeds"]))
        out_shape = [1, None, DIM]
    text = helper.make_graph(
        nodes,
        "text",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, None]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, None]),
        ],
        [helper.make_tensor_value_info("text_embeds", TensorProto.FLOAT, out_shape)],
        [table],
    )
    _save(text, dir_ / "text.onnx")
    _tokenizer(dir_)
    return dir_
