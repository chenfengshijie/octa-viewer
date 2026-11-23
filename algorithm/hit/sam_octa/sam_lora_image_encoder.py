"""SAM-OCTA 的 Q/V 低秩适配器；属性名与交接权重的 state_dict 对齐。"""

from torch import nn

from .segment_anything.modeling import Sam


class AdaptedQKV(nn.Module):
    def __init__(self, qkv: nn.Linear, rank: int):
        super().__init__()
        width = qkv.in_features
        self.qkv = qkv
        self.linear_a_q = nn.Linear(width, rank, bias=False)
        self.linear_b_q = nn.Linear(rank, width, bias=False)
        self.linear_a_v = nn.Linear(width, rank, bias=False)
        self.linear_b_v = nn.Linear(rank, width, bias=False)
        nn.init.zeros_(self.linear_b_q.weight)
        nn.init.zeros_(self.linear_b_v.weight)

    def forward(self, x):
        projected = self.qkv(x)
        width = self.qkv.in_features
        projected[..., :width] += self.linear_b_q(self.linear_a_q(x))
        projected[..., -width:] += self.linear_b_v(self.linear_a_v(x))
        return projected


class LoRA_Sam(nn.Module):
    def __init__(self, sam_model: Sam, r: int):
        super().__init__()
        self.sam = sam_model.requires_grad_(False)
        for block in self.sam.image_encoder.blocks:
            block.attn.qkv = AdaptedQKV(block.attn.qkv, r)

    def forward(self, images, original_size, point_coords, point_labels, multimask_output=False):
        input_size = tuple(images.shape[-2:])
        images = self.sam.preprocess(images)
        image_features = self.sam.image_encoder(images)

        sparse_embeddings, dense_embeddings = self.sam.prompt_encoder(
            points=(point_coords, point_labels),
            boxes=None,
            masks=None,
        )

        # Predict masks
        low_res_masks, _ = self.sam.mask_decoder(
            image_embeddings=image_features,
            image_pe=self.sam.prompt_encoder.get_dense_pe(),
            sparse_prompt_embeddings=sparse_embeddings,
            dense_prompt_embeddings=dense_embeddings,
            multimask_output=multimask_output,
        )

        # Upscale the masks to the original image resolution
        masks = self.sam.postprocess_masks(low_res_masks, input_size, original_size)
        return masks.sigmoid()
