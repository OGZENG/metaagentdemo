import { Box, Typography } from '@mui/material'

// ==============================|| LOGO ||============================== //

const Logo = () => {
    return (
        <Box sx={{ alignItems: 'center', display: 'flex', ml: 1.25, gap: 1.25 }} aria-label='TUM Meta-Agent'>
            <Box
                sx={{
                    backgroundColor: '#0065BD',
                    color: '#fff',
                    px: 1.25,
                    py: 0.5,
                    fontSize: 20,
                    fontWeight: 800,
                    lineHeight: 1,
                    letterSpacing: '0.04em'
                }}
            >
                TUM
            </Box>
            <Typography variant='subtitle1' sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                Meta-Agent
            </Typography>
        </Box>
    )
}

export default Logo
