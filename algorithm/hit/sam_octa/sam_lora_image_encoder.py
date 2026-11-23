import math
import torch
import torch.nn as nn
from segment_anything.modeling import Sam


class _LoRA_qkv(nn.Module):
    """In Sam it is implemented as
    self.qkv = nn.Linear(dim, dim * 3, bias=qkv_bias)
    B, N, C = x.shape
    qkv = self.qkv(x).reshape(B, N, 3, self.num_heads, self.head_dim).permute(2, 0, 3, 1, 4)
    q, k, v = qkv.unbind(0)
    """

    def __init__(
            self,
            qkv: nn.Module,
            linear_a_q: nn.Module,
            linear_b_q: nn.Module,
            linear_a_v: nn.Module,
            linear_b_v: nn.Module,
    ):
        super().__init__()
        self.qkv = qkv
        self.linear_a_q = linear_a_q
        self.linear_b_q = linear_b_q
        self.linear_a_v = linear_a_v
        self.linear_b_v = linear_b_v
        self.dim = qkv.in_features

    def forward(self, x):
        qkv = self.qkv(x)  # B,N,N,3*org_C
        new_q = self.linear_b_q(self.linear_a_q(x))
        new_v = self.linear_b_v(self.linear_a_v(x))
        qkv[:, :, :, : self.dim] += new_q
        qkv[:, :, :, -self.dim:] += new_v
        return qkv


class LoRA_Sam(nn.Module):
    """Apply the handoff model’s rank-r adapters to every image encoder block."""

    def __init__(self, sam_model: Sam, r: int):
        super(LoRA_Sam, self).__init__()

        assert r > 0
        self.w_As, self.w_Bs = [], []
        for param in sam_model.parameters():
            param.requires_grad = False

        for blk in sam_model.image_encoder.blocks:
            w_qkv_linear = blk.attn.qkv
            self.dim = w_qkv_linear.in_features
            w_a_linear_q = nn.Linear(self.dim, r, bias=False)
            w_b_linear_q = nn.Linear(r, self.dim, bias=False)
            w_a_linear_v = nn.Linear(self.dim, r, bias=False)
            w_b_linear_v = nn.Linear(r, self.dim, bias=False)
            self.w_As.append(w_a_linear_q)
            self.w_Bs.append(w_b_linear_q)
            self.w_As.append(w_a_linear_v)
            self.w_Bs.append(w_b_linear_v)
            blk.attn.qkv = _LoRA_qkv(
                w_qkv_linear,
                w_a_linear_q,
                w_b_linear_q,
                w_a_linear_v,
                w_b_linear_v,
            )
        self.reset_parameters()
        self.sam = sam_model

    def reset_parameters(self) -> None:
        for w_A in self.w_As: nn.init.kaiming_uniform_(w_A.weight, a=math.sqrt(5))
        for w_B in self.w_Bs: nn.init.zeros_(w_B.weight)

    def forward(self, images, original_size, point_coords, point_labels, multimask_output=False):
        input_size = tuple(images.shape[-2:])
        images = self.sam.preprocess(images)
        image_features = self.sam.image_encoder(images) # shape: 1, 256, 64, 64, range: 0-1

        sparse_embeddings, dense_embeddings = self.sam.prompt_encoder(
            points=(point_coords, point_labels),
            boxes=None,
            masks=None,
        )

        # Predict masks
        low_res_masks, iou_predictions = self.sam.mask_decoder(
            image_embeddings=image_features,
            image_pe=self.sam.prompt_encoder.get_dense_pe(),
            sparse_prompt_embeddings=sparse_embeddings,
            dense_prompt_embeddings=dense_embeddings,
            multimask_output=multimask_output,
        )

        # Upscale the masks to the original image resolution
        masks = self.sam.postprocess_masks(low_res_masks, input_size, original_size)
        return nn.Sigmoid()(masks)
