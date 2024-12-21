from pydantic import BaseModel

class SSHKeyResponse(BaseModel):
    private: str
    public: str
