from pydantic import BaseModel, ConfigDict, RootModel, Field
from typing import Dict, List, Optional, Union, Any
from enum import Enum

#
# Enums for field type and condition operators
#
class FieldTypeEnum(str, Enum):
    string = "string"
    float_ = "float"
    integer = "integer"
    boolean = "boolean"
    color = "color"
    json = "json"
    node = "node"
    scene = "scene"
    image = "image"
    text = "text"
    select = "select"
    font = "font"


class ConfigFieldConditionOperator(str, Enum):
    eq = "eq"
    ne = "ne"
    gt = "gt"
    lt = "lt"
    gte = "gte"
    lte = "lte"
    empty = "empty"
    notEmpty = "notEmpty"
    In = "in"
    notIn = "notIn"


#
# Conditions (single and AND-group)
#
class ConfigFieldCondition(BaseModel):
    """
    A single condition, e.g.:
      {
        "field": ".meta.showOutput",
        "op": "eq",
        "value": true
      }
    or
      {
        "op": "notEmpty"
      }
    """
    field: Optional[str] = Field(
        None,
        description="Key of the field to compare (optional if using operators like 'notEmpty')."
    )
    operator: Optional[ConfigFieldConditionOperator] = Field(
        None,
        description="Comparison operator used for this condition."
    )
    value: Optional[Any] = Field(
        None,
        description="Value to compare against (if applicable)."
    )


class ConfigFieldConditionAnd(BaseModel):
    """
    A condition that contains multiple sub-conditions
    that must all be met (logical AND).
    Example:
      {
        "and": [
          {"field": ".meta.showOutput", "op": "notEmpty"},
          {"field": "inputImage", "op": "eq", "value": "some.png"}
        ]
      }
    """
    and_: List[ConfigFieldCondition] = Field(
        ..., alias="and",
        description="Logical AND of multiple conditions."
    )


#
# We can now define a union so that "showIf" can contain either a single condition
# or an 'and' group of conditions.
#
ShowIfCondition = Union[ConfigFieldCondition, ConfigFieldConditionAnd]


#
# Schema for config fields
#
class AppConfigField(BaseModel):
    """
    A single input field in the 'fields' array
    """
    name: str = Field(..., description="Unique config field keyword")
    label: str = Field(..., description="Human-readable label")
    type: FieldTypeEnum = Field(..., description="Type of this field (string, boolean, select, etc.)")
    options: Optional[List[str]] = Field(
        None,
        description="List of options if the field type is 'select'"
    )
    required: bool = Field(False, description="Whether the field is required")
    secret: bool = Field(False, description="If true, hide the field content (for passwords, tokens, etc.)")
    value: Optional[Any] = Field(None, description="Default value for this field")
    placeholder: Optional[str] = Field(None, description="Placeholder text")
    hint: Optional[str] = Field(None, description="Tooltip or help text (Markdown allowed)")
    rows: Optional[int] = Field(None, description="Number of rows for text-like fields")
    seq: Optional[List[List[Any]]] = Field(
        None,
        description="Define if the field can contain multiple subfields or array-like content"
    )
    showIf: Optional[List[ShowIfCondition]] = Field(
        None,
        description="Conditions to determine if this field is displayed"
    )


class MarkdownField(BaseModel):
    """
    A block of markdown text that can appear in the fields array to provide
    additional instructions or notes, rather than being a user-input field.
    """
    markdown: Optional[str] = Field(
        None,
        description="Markdown content to render. If omitted, this can allow fallback behavior."
    )
    showIf: Optional[List[ShowIfCondition]] = Field(
        None,
        description="Conditions to determine if this markdown block is displayed"
    )


#
# Output and cache sections
#
class OutputField(BaseModel):
    """
    Describes the data this app returns (exposed to downstream nodes).
    """
    name: str = Field(..., description="Name of the output field")
    type: FieldTypeEnum = Field(..., description="Type of this output field")


class CacheConfig(BaseModel):
    enabled: bool = Field(False, description="Enable caching?")
    inputEnabled: bool = Field(False, description="Cache inputs?")
    durationEnabled: bool = Field(False, description="Enable specifying a cache duration?")
    duration: Optional[str] = Field(None, description="Duration string like '5m' or '1h'")
    expressionEnabled: bool = Field(False, description="Enable caching only when expression is true?")
    expression: Optional[str] = Field(None, description="Custom expression code/logic")
    expressionType: Optional[FieldTypeEnum] = Field(None, description="Type of the expression output")


#
# Main schema (config.json)
#
FieldsUnion = Union[AppConfigField, MarkdownField]

class AppConfigSchema(BaseModel):
    """
    Represents the contents of config.json for a FrameOS app.
    """
    name: str = Field(..., description="Name of the app")
    category: Optional[str] = Field(None, description="Category of this app")
    description: Optional[str] = Field(None, description="Short description for this app")
    version: Optional[str] = Field(None, description="Version number for this app")
    settings: Optional[List[str]] = Field(
        None,
        description="List of global settings keys that this app depends on (pulled from system settings)."
    )

    # The fields array can contain either an interactive form field or a block of markdown
    fields: Optional[List[FieldsUnion]] = Field(
        None,
        description="List of fields (and optional markdown) for configuring this app"
    )
    output: Optional[List[OutputField]] = Field(
        None,
        description="List of output fields generated by the app"
    )
    cache: Optional[CacheConfig] = Field(None, description="Default cache settings for this app")

    model_config = ConfigDict(
        json_schema_extra = {
            "example": {
                "name": "My Custom Clock",
                "category": "clocks",
                "description": "Displays a customizable clock on your e-ink display",
                "version": "1.2.0",
                "settings": ["timeZone", "language"],
                "fields": [
                    {
                        "name": "clockStyle",
                        "label": "Clock Style",
                        "type": "select",
                        "options": ["digital", "analog"],
                        "required": True,
                        "value": "digital"
                    },
                    {
                        "markdown": "Choose how the clock is displayed. Digital vs. analog is purely a matter of style."
                    }
                ],
                "output": [
                    {
                        "name": "timestamp",
                        "type": "string"
                    }
                ],
                "cache": {
                    "enabled": True,
                    "durationEnabled": True,
                    "duration": "5m"
                }
            }
        }
    )


#
# Additional API schemas
#
class AppsListResponse(BaseModel):
    apps: Dict[str, AppConfigSchema]


class AppsSourceResponse(RootModel):
    """
    filename -> source code mapping
    """
    pass


class ValidateSourceRequest(BaseModel):
    file: str
    source: str


class ValidateError(BaseModel):
    line: int
    column: int
    error: str


class ValidateSourceResponse(BaseModel):
    errors: List[ValidateError]


class EnhanceSourceRequest(BaseModel):
    source: str
    prompt: str


class EnhanceSourceResponse(BaseModel):
    suggestion: Optional[str] = None
    error: Optional[str] = None
